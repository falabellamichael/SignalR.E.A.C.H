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

    /// The RCH token whose redemptions this contract moves. Immutable by design: a token that
    /// could be re-pointed would let the owner redirect every future redemption.
    IERC20 public immutable token;
    /// The treasury that receives redeemed RCH. Immutable for the same reason.
    address public immutable treasury;
    /// Smallest credit a single quote may grant. Set once because shrinking it only tightens
    /// policy, while a zero floor would make accidental zero-credit quotes valid.
    uint256 public immutable minCreditUsdMicros;
    /// Largest credit a single quote may grant. This is the on-chain ceiling Dave was missing;
    /// keeping it immutable means loosening it requires a new deployment, in the open.
    uint256 public immutable maxCreditUsdMicros;

    /// The key allowed to sign redemption quotes. NOT immutable: a leaked or lost signing key
    /// must be replaceable. The service holds only this key, never the owner key, so a rotated
    /// signer cannot itself grant the role back or move funds.
    address public quoteSigner;

    /// Wallets permitted to redeem. Without this the signature binds msg.sender but says nothing
    /// about who msg.sender is, so a compromised signer could quote any address. Enforcing the
    /// allowlist on-chain is what actually contains the pilot.
    mapping(address => bool) public allowedWallet;
    mapping(bytes32 => bool) public usedRedemptionIds;

    error InvalidConfiguration();
    error InvalidQuote();
    error QuoteExpired();
    error RedemptionAlreadyUsed(bytes32 redemptionId);
    error InexactTransfer();
    error WalletNotAllowed();
    error CreditOutOfBounds();

    event RedeemedToTreasury(
        address indexed wallet,
        bytes32 indexed redemptionId,
        address indexed treasury,
        uint256 amount,
        uint256 creditUsdMicros
    );

    /// Emitted on every signer change so a rotation is visible without reading storage.
    event QuoteSignerChanged(address indexed previousSigner, address indexed newSigner);
    event WalletAllowanceChanged(address indexed wallet, bool allowed);

    constructor(
        address initialOwner,
        address token_,
        address treasury_,
        address quoteSigner_,
        uint256 minCreditUsdMicros_,
        uint256 maxCreditUsdMicros_
    ) Ownable(initialOwner) {
        if (token_ == address(0) || treasury_ == address(0) || quoteSigner_ == address(0)
            || token_ == treasury_ || token_.code.length == 0) revert InvalidConfiguration();
        // Validate the bounds here rather than trusting the service: a zero ceiling would brick
        // redemption, and an inverted range would reject every quote.
        if (minCreditUsdMicros_ == 0 || minCreditUsdMicros_ > maxCreditUsdMicros_) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_);
        treasury = treasury_;
        quoteSigner = quoteSigner_;
        minCreditUsdMicros = minCreditUsdMicros_;
        maxCreditUsdMicros = maxCreditUsdMicros_;
        _pause();
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Replace the quote signing key. Exists so a leaked or lost key does not force a
    /// redeploy and a migration of every holder's RCH.
    /// @dev Owner-only. The service never holds this key, so a compromised signer cannot call it.
    function setQuoteSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0) || newSigner == quoteSigner) revert InvalidConfiguration();
        emit QuoteSignerChanged(quoteSigner, newSigner);
        quoteSigner = newSigner;
    }

    /// @notice Grant or revoke one wallet's permission to redeem.
    /// @dev Owner-only, and the redeemed wallet is still bound by the signed quote, so this only
    /// narrows the set of callers a valid quote can serve.
    function setAllowedWallet(address wallet, bool allowed) external onlyOwner {
        if (wallet == address(0)) revert InvalidConfiguration();
        allowedWallet[wallet] = allowed;
        emit WalletAllowanceChanged(wallet, allowed);
    }

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
        // The on-chain ceiling. Without this, creditUsdMicros is bounded only by a Node process
        // that the chain never consults, so a compromised signer could quote any amount.
        if (creditUsdMicros < minCreditUsdMicros || creditUsdMicros > maxCreditUsdMicros) {
            revert CreditOutOfBounds();
        }
        // Contain the pilot: a signed quote for an address outside the allowlist is refused here
        // even though the signature itself only proves the signer authorised that address.
        if (!allowedWallet[msg.sender]) revert WalletNotAllowed();
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
