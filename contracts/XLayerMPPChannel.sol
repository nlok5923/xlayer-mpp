// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title XLayerMPPChannel
 * @notice On-chain escrow contract for MPP (Machine Payments Protocol) session channels.
 *
 * Flow:
 *   1. Payer calls open()  — deposits ERC-20 tokens into escrow, channel is "open"
 *   2. Off-chain: payer signs EIP-712 vouchers incrementing cumulativeAmount per request
 *   3. Recipient calls settle() with the final signed voucher — claims payment, refunds remainder
 *   4. If recipient never settles, payer calls expire() after channel expiry to reclaim funds
 *
 * The EIP-712 domain binds signatures to this contract address, preventing
 * vouchers from being replayed on other deployments.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract XLayerMPPChannel {

    // ─── EIP-712 ──────────────────────────────────────────────────────────────

    bytes32 private immutable DOMAIN_SEPARATOR;

    bytes32 private constant VOUCHER_TYPEHASH = keccak256(
        "SessionVoucher("
            "string channelId,"
            "address payer,"
            "address recipient,"
            "address asset,"
            "uint256 cumulativeAmount,"
            "uint256 sequence,"
            "string serverNonce,"
            "uint256 expiresAt,"
            "uint256 chainId"
        ")"
    );

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("XLayerMPPSession"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ─── Channel state ────────────────────────────────────────────────────────

    enum ChannelStatus { Open, Settled, Expired }

    struct Channel {
        address payer;
        address recipient;
        address asset;
        uint256 depositAmount;
        uint64  expiresAt;    // unix seconds; 0 = no expiry
        ChannelStatus status;
    }

    // channelKey = keccak256(bytes(channelId string))
    mapping(bytes32 => Channel) public channels;

    // ─── Events ───────────────────────────────────────────────────────────────

    event ChannelOpened(
        bytes32 indexed channelKey,
        string  channelId,
        address indexed payer,
        address indexed recipient,
        address asset,
        uint256 depositAmount,
        uint64  expiresAt
    );

    event ChannelToppedUp(
        bytes32 indexed channelKey,
        uint256 additionalAmount,
        uint256 newDepositAmount
    );

    event ChannelSettled(
        bytes32 indexed channelKey,
        uint256 settledAmount,
        uint256 refundAmount
    );

    event ChannelExpired(
        bytes32 indexed channelKey,
        uint256 refundAmount
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ChannelAlreadyExists(bytes32 channelKey);
    error ChannelNotFound(bytes32 channelKey);
    error ChannelNotOpen(ChannelStatus status);
    error NotRecipient();
    error NotPayer();
    error ChannelNotExpired();
    error ExceedsDeposit(uint256 requested, uint256 deposited);
    error InvalidSignature();
    error ZeroDeposit();

    // ─── open ─────────────────────────────────────────────────────────────────

    /**
     * @notice Open a payment channel by depositing ERC-20 tokens into escrow.
     * @dev    Caller must have approved this contract for `depositAmount` tokens first.
     * @param channelId     Client-generated UUID string (e.g. "550e8400-e29b-41d4-a716-446655440000")
     * @param recipient     Server address that will receive settled funds
     * @param asset         ERC-20 token address (e.g. USDC)
     * @param depositAmount Amount to lock in escrow (in token base units)
     * @param expiresAt     Unix timestamp after which payer can reclaim; 0 = no expiry
     */
    function open(
        string calldata channelId,
        address recipient,
        address asset,
        uint256 depositAmount,
        uint64  expiresAt
    ) external {
        if (depositAmount == 0) revert ZeroDeposit();

        bytes32 channelKey = keccak256(bytes(channelId));
        if (channels[channelKey].payer != address(0)) revert ChannelAlreadyExists(channelKey);

        IERC20(asset).transferFrom(msg.sender, address(this), depositAmount);

        channels[channelKey] = Channel({
            payer:         msg.sender,
            recipient:     recipient,
            asset:         asset,
            depositAmount: depositAmount,
            expiresAt:     expiresAt,
            status:        ChannelStatus.Open
        });

        emit ChannelOpened(channelKey, channelId, msg.sender, recipient, asset, depositAmount, expiresAt);
    }

    // ─── topup ────────────────────────────────────────────────────────────────

    /**
     * @notice Add more funds to an existing open channel.
     * @dev    Caller must be the original payer and have approved this contract.
     */
    function topup(string calldata channelId, uint256 additionalAmount) external {
        bytes32 channelKey = keccak256(bytes(channelId));
        Channel storage ch = channels[channelKey];

        if (ch.payer == address(0))          revert ChannelNotFound(channelKey);
        if (ch.status != ChannelStatus.Open) revert ChannelNotOpen(ch.status);
        if (msg.sender != ch.payer)          revert NotPayer();

        IERC20(ch.asset).transferFrom(msg.sender, address(this), additionalAmount);
        ch.depositAmount += additionalAmount;

        emit ChannelToppedUp(channelKey, additionalAmount, ch.depositAmount);
    }

    // ─── settle ───────────────────────────────────────────────────────────────

    /**
     * @notice Settle the channel using the final signed voucher from the payer.
     * @dev    Only the recipient can call this. Verifies the EIP-712 signature,
     *         transfers `cumulativeAmount` to recipient, refunds remainder to payer.
     *
     * @param channelId       The channel UUID string
     * @param cumulativeAmount Total amount authorized by the payer (must be <= depositAmount)
     * @param sequence        Sequence number of the voucher (informational, not enforced on-chain)
     * @param serverNonce     Nonce from the challenge (included in signed data)
     * @param expiresAt       Voucher expiry timestamp (0 = no expiry)
     * @param chainId         Chain ID included in the signed voucher
     * @param payerSig        EIP-712 signature produced by the payer's wallet
     */
    function settle(
        string  calldata channelId,
        uint256 cumulativeAmount,
        uint256 sequence,
        string  calldata serverNonce,
        uint256 expiresAt,
        uint256 chainId,
        bytes   calldata payerSig
    ) external {
        bytes32 channelKey = keccak256(bytes(channelId));
        Channel storage ch = channels[channelKey];

        if (ch.payer == address(0))          revert ChannelNotFound(channelKey);
        if (ch.status != ChannelStatus.Open) revert ChannelNotOpen(ch.status);
        if (msg.sender != ch.recipient)      revert NotRecipient();
        if (cumulativeAmount > ch.depositAmount) revert ExceedsDeposit(cumulativeAmount, ch.depositAmount);

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            VOUCHER_TYPEHASH,
            keccak256(bytes(channelId)),
            ch.payer,
            ch.recipient,
            ch.asset,
            cumulativeAmount,
            sequence,
            keccak256(bytes(serverNonce)),
            expiresAt,
            chainId
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recover(digest, payerSig);
        if (recovered != ch.payer) revert InvalidSignature();

        ch.status = ChannelStatus.Settled;

        uint256 refund = ch.depositAmount - cumulativeAmount;

        if (cumulativeAmount > 0) {
            IERC20(ch.asset).transfer(ch.recipient, cumulativeAmount);
        }
        if (refund > 0) {
            IERC20(ch.asset).transfer(ch.payer, refund);
        }

        emit ChannelSettled(channelKey, cumulativeAmount, refund);
    }

    // ─── expire ───────────────────────────────────────────────────────────────

    /**
     * @notice Reclaim escrowed funds after the channel has expired.
     * @dev    Only callable by the payer after `expiresAt`. Intended as a safety
     *         net if the recipient never calls settle().
     */
    function expire(string calldata channelId) external {
        bytes32 channelKey = keccak256(bytes(channelId));
        Channel storage ch = channels[channelKey];

        if (ch.payer == address(0))          revert ChannelNotFound(channelKey);
        if (ch.status != ChannelStatus.Open) revert ChannelNotOpen(ch.status);
        if (msg.sender != ch.payer)          revert NotPayer();
        if (ch.expiresAt == 0 || block.timestamp <= ch.expiresAt) revert ChannelNotExpired();

        ch.status = ChannelStatus.Expired;

        IERC20(ch.asset).transfer(ch.payer, ch.depositAmount);

        emit ChannelExpired(channelKey, ch.depositAmount);
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    function getChannel(string calldata channelId) external view returns (Channel memory) {
        return channels[keccak256(bytes(channelId))];
    }

    function getChannelByKey(bytes32 channelKey) external view returns (Channel memory) {
        return channels[channelKey];
    }

    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    // ─── ECDSA helper ─────────────────────────────────────────────────────────

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
