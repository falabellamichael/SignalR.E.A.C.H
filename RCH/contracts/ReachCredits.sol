// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @notice Transferable RCH. Supply starts at zero and grows only through approved issuance.
/// @dev No subscription or AI usage accounting belongs in this token contract.
contract ReachCredits is ERC20, AccessControlDefaultAdminRules {
    bytes32 public constant SALE_MINTER_ROLE = keccak256("SALE_MINTER_ROLE");
    bytes32 public constant REWARD_MINTER_ROLE = keccak256("REWARD_MINTER_ROLE");

    mapping(address => uint256) public rewardAllowance;
    mapping(bytes32 => bool) public usedRewardIds;
    uint256 public totalPurchased;
    uint256 public totalRewarded;
    bool public issuancePaused;

    error IssuancePaused();
    error InvalidIssuance();
    error RewardAlreadyIssued(bytes32 rewardId);
    error RewardBudgetExceeded();

    event RewardMinted(address indexed operator, address indexed recipient, bytes32 indexed rewardId, uint256 amount);
    event RewardAllowanceSet(address indexed operator, uint256 remaining);
    event IssuancePauseChanged(bool paused);

    constructor(address admin)
        ERC20("REACH Credits", "RCH")
        AccessControlDefaultAdminRules(2 days, admin)
    {}

    /// @notice Called only by the approved ETH sale contract after a purchase.
    function mintPurchased(address recipient, uint256 amount) external onlyRole(SALE_MINTER_ROLE) {
        _checkIssuance(amount);
        totalPurchased += amount;
        _mint(recipient, amount);
    }

    /// @notice Sets remaining spendable RCH, not a lifetime or periodic allocation.
    function setRewardAllowance(address operator, uint256 remaining) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!hasRole(REWARD_MINTER_ROLE, operator)) revert InvalidIssuance();
        rewardAllowance[operator] = remaining;
        emit RewardAllowanceSet(operator, remaining);
    }

    /// @notice Supply is uncapped, but each reward operator has a finite, explicit allowance.
    /// @dev rewardId is a unique opaque identifier. Do not put customer data in it.
    function mintReward(address recipient, uint256 amount, bytes32 rewardId) external onlyRole(REWARD_MINTER_ROLE) {
        _checkIssuance(amount);
        if (rewardId == bytes32(0)) revert InvalidIssuance();
        if (usedRewardIds[rewardId]) revert RewardAlreadyIssued(rewardId);
        if (amount > rewardAllowance[msg.sender]) revert RewardBudgetExceeded();
        rewardAllowance[msg.sender] -= amount;
        usedRewardIds[rewardId] = true;
        totalRewarded += amount;
        _mint(recipient, amount);
        emit RewardMinted(msg.sender, recipient, rewardId, amount);
    }

    /// @notice Stops new issuance while existing RCH remains transferable.
    function setIssuancePaused(bool paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        issuancePaused = paused;
        emit IssuancePauseChanged(paused);
    }

    function _checkIssuance(uint256 amount) private view {
        if (issuancePaused) revert IssuancePaused();
        if (amount == 0) revert InvalidIssuance();
    }

    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        bool revoked = super._revokeRole(role, account);
        if (revoked && role == REWARD_MINTER_ROLE) {
            delete rewardAllowance[account];
            emit RewardAllowanceSet(account, 0);
        }
        return revoked;
    }
}
