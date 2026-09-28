// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Moves quoted RCH redemptions to the treasury instead of burning them.
/// @dev Off-chain credit is issued only after the service verifies this event and chain finality.
contract ReachTreasuryRedemption is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "RedemptionQuote(address wallet,uint256 amount,uint256 creditUsdMicros,bytes32 redemptionId,uint64 issuedAt,uint64 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("REACH Treasury Redemption");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint64 public constant MAX_QUOTE_SECONDS = 900;

    IERC20 public immutable token;
    address public immutable treasury;
    address public immutable quoteSigner;
    mapping(bytes32 => bool) public usedRedemptionIds;

    error InvalidConfiguration();
    error InvalidQuote();
    error QuoteExpired();
    error RedemptionAlreadyUsed(bytes32 redemptionId);
    error InexactTransfer();

    event RedeemedToTreasury(
        address indexed wallet,
        bytes32 indexed redemptionId,
        address indexed treasury,
        uint256 amount,
        uint256 creditUsdMicros
    );

    constructor(address initialOwner, address token_, address treasury_, address quoteSigner_)
        Ownable(initialOwner)
    {
        if (token_ == address(0) || treasury_ == address(0) || quoteSigner_ == address(0)
            || token_ == treasury_ || token_.code.length == 0) revert InvalidConfiguration();
        token = IERC20(token_);
        treasury = treasury_;
        quoteSigner = quoteSigner_;
        _pause();
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function redeem(
        uint256 amount,
        uint256 creditUsdMicros,
        bytes32 redemptionId,
        uint64 issuedAt,
        uint64 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        if (amount == 0 || creditUsdMicros == 0 || redemptionId == bytes32(0)
            || issuedAt == 0 || deadline < issuedAt || deadline - issuedAt > MAX_QUOTE_SECONDS) {
            revert InvalidQuote();
        }
        if (block.timestamp < issuedAt || block.timestamp > deadline) revert QuoteExpired();
        if (usedRedemptionIds[redemptionId]) revert RedemptionAlreadyUsed(redemptionId);
        bytes32 structHash = keccak256(abi.encode(
            QUOTE_TYPEHASH, msg.sender, amount, creditUsdMicros, redemptionId, issuedAt, deadline
        ));
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        if (ECDSA.recover(digest, signature) != quoteSigner) revert InvalidQuote();

        usedRedemptionIds[redemptionId] = true;
        uint256 beforeBalance = token.balanceOf(treasury);
        token.safeTransferFrom(msg.sender, treasury, amount);
        if (token.balanceOf(treasury) - beforeBalance != amount) revert InexactTransfer();
        emit RedeemedToTreasury(msg.sender, redemptionId, treasury, amount, creditUsdMicros);
    }
}
