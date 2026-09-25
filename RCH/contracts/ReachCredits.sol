// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @notice Transferable RCH with approved issuance and holder-authorized burn-to-credit redemption.
/// @dev Redemption emits an entitlement amount; the hosted service settles and meters the actual usage.
contract ReachCredits is ERC20, AccessControlDefaultAdminRules {
    bytes32 public constant SALE_MINTER_ROLE = keccak256("SALE_MINTER_ROLE");
    bytes32 public constant REWARD_MINTER_ROLE = keccak256("REWARD_MINTER_ROLE");
    uint256 public constant AI_TOKENS_PER_RCH = 1_000_000;
    uint256 public constant RCH_UNITS_PER_AI_TOKEN = 10 ** 18 / AI_TOKENS_PER_RCH;

    mapping(address => uint256) public rewardAllowance;
    mapping(bytes32 => bool) public usedRewardIds;
    mapping(bytes32 => bool) public usedRedemptionIds;
    uint256 public totalPurchased;
    uint256 public totalRewarded;
    uint256 public totalRedeemed;
    uint256 public totalUsageTokensRedeemed;
    bool public issuancePaused;
    bool public redemptionPaused = true;

    error IssuancePaused();
    error InvalidIssuance();
    error RewardAlreadyIssued(bytes32 rewardId);
    error RewardBudgetExceeded();
    error RedemptionPaused();
    error InvalidRedemption();
    error RedemptionAlreadyUsed(bytes32 redemptionId);

    event RewardMinted(address indexed operator, address indexed recipient, bytes32 indexed rewardId, uint256 amount);
    event RewardAllowanceSet(address indexed operator, uint256 remaining);
    event IssuancePauseChanged(bool paused);
    event Redeemed(address indexed wallet, bytes32 indexed redemptionId, uint256 amount, uint256 usageTokens);
    event RedemptionPauseChanged(bool paused);

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

    /// @notice Burns the caller's RCH permanently for a precise, whole number of AI usage tokens.
    /// @dev Obtain a random, opaque intent ID from the service before redeeming. No personal data.
    /// The service must verify this event and finality before crediting the wallet's account once.
    /// No spender or administrator can burn another holder's balance through this function.
    function redeem(uint256 amount, bytes32 redemptionId) external returns (uint256 usageTokens) {
        if (redemptionPaused) revert RedemptionPaused();
        if (amount == 0 || amount % RCH_UNITS_PER_AI_TOKEN != 0 || redemptionId == bytes32(0)) {
            revert InvalidRedemption();
        }
        if (usedRedemptionIds[redemptionId]) revert RedemptionAlreadyUsed(redemptionId);
        usageTokens = amount / RCH_UNITS_PER_AI_TOKEN;
        usedRedemptionIds[redemptionId] = true;
        totalRedeemed += amount;
        totalUsageTokensRedeemed += usageTokens;
        _burn(msg.sender, amount);
        emit Redeemed(msg.sender, redemptionId, amount, usageTokens);
    }

    /// @notice Open only after the hosted service is configured to settle confirmed burns.
    /// @dev Independent of issuance; changing this flag never stops ERC20 transfers or approvals.
    function setRedemptionPaused(bool paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        redemptionPaused = paused;
        emit RedemptionPauseChanged(paused);
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
