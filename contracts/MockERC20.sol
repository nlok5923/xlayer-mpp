// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Minimal ERC-20 for local end-to-end testing.
 * Mints `initialSupply` to `mintTo` on deploy.
 * No access control — fine for local Anvil tests only.
 */
contract MockERC20 {
    string  public name     = "Mock USDC";
    string  public symbol   = "mUSDC";
    uint8   public decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address mintTo, uint256 initialSupply) {
        totalSupply       = initialSupply;
        balanceOf[mintTo] = initialSupply;
        emit Transfer(address(0), mintTo, initialSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        unchecked {
            balanceOf[msg.sender] -= amount;
            balanceOf[to]         += amount;
        }
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        unchecked {
            allowance[from][msg.sender] -= amount;
            balanceOf[from]             -= amount;
            balanceOf[to]               += amount;
        }
        emit Transfer(from, to, amount);
        return true;
    }
}
