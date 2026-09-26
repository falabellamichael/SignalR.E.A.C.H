// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReachCredits} from "./ReachCredits.sol";
import {IEthUsdFeed} from "./interfaces/IEthUsdFeed.sol";

/// @notice Open ETH-for-RCH sale targeting $0.01 USD per whole RCH.
/// @dev The ETH amount changes with the ETH/USD oracle; a secondary market can trade at another price.
contract ReachCreditsSale is Ownable2Step, Pausable, ReentrancyGuard {
    uint8 public constant FEED_DECIMALS = 8;
    uint256 public constant USD_PRICE_E8_PER_RCH = 1_000_000; // $0.01
    uint256 public constant MIN_PURCHASE_WEI = 0.001 ether;

    ReachCredits public immutable rch;
    IEthUsdFeed public immutable ethUsdFeed;
    address payable public immutable treasury;
    uint256 public immutable maxOracleAge;
    uint256 public immutable minEthUsdPriceE8;
    uint256 public immutable maxEthUsdPriceE8;
    bool public saleClosed;

    error InvalidConfiguration();
    error InvalidOraclePrice();
    error StaleOraclePrice();
    error PurchaseExpired();
    error EmptyPurchase();
    error PaymentBelowMinimum(uint256 paid, uint256 minimum);
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error TreasuryTransferFailed();
    error SaleClosed();
    error PriceOutsideBounds();
    error OwnershipRenunciationDisabled();

    event Purchased(address indexed buyer, uint256 ethPaid, uint256 rchReceived, uint256 ethUsdPriceE8);
    event ProceedsWithdrawn(address indexed treasury, uint256 amount);
    event SalePermanentlyClosed();

    constructor(
        ReachCredits token_,
        IEthUsdFeed feed_,
        address payable treasury_,
        address admin_,
        uint256 maxOracleAge_,
        uint256 minEthUsdPriceE8_,
        uint256 maxEthUsdPriceE8_
    ) Ownable(admin_) {
        if (
            address(token_) == address(0) || address(feed_) == address(0)
                || treasury_ == address(0) || treasury_ == address(this)
                || admin_ == address(0) || maxOracleAge_ == 0
                || minEthUsdPriceE8_ == 0 || minEthUsdPriceE8_ >= maxEthUsdPriceE8_
        ) revert InvalidConfiguration();
        // The launch token creates its sale while its own constructor is running.
        if (address(token_).code.length == 0 && address(token_) != msg.sender) revert InvalidConfiguration();
        if (address(token_).code.length > 0 && token_.decimals() != 18) revert InvalidConfiguration();
        if (address(feed_).code.length == 0) revert InvalidConfiguration();
        if (feed_.decimals() != FEED_DECIMALS) revert InvalidConfiguration();
        if (keccak256(bytes(feed_.description())) != keccak256(bytes("ETH / USD"))) revert InvalidConfiguration();
        rch = token_;
        ethUsdFeed = feed_;
        treasury = treasury_;
        maxOracleAge = maxOracleAge_;
        minEthUsdPriceE8 = minEthUsdPriceE8_;
        maxEthUsdPriceE8 = maxEthUsdPriceE8_;
        _pause();
    }

    /// @notice Returns RCH base units and the ETH/USD answer used for a proposed payment.
    function quote(uint256 ethWei) public view returns (uint256 rchBaseUnits, uint256 ethUsdPriceE8) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = ethUsdFeed.latestRoundData();
        if (roundId == 0 || answeredInRound < roundId || answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidOraclePrice();
        if (block.timestamp - updatedAt > maxOracleAge) revert StaleOraclePrice();

        ethUsdPriceE8 = uint256(answer);
        if (ethUsdPriceE8 < minEthUsdPriceE8 || ethUsdPriceE8 > maxEthUsdPriceE8) revert PriceOutsideBounds();
        // Both ETH and RCH use 18 base-unit decimals; the USD scale cancels out.
        rchBaseUnits = Math.mulDiv(ethWei, ethUsdPriceE8, USD_PRICE_E8_PER_RCH);
    }

    /// @param minRchOut Minimum acceptable RCH base units; protects against quote changes.
    /// @param deadline Latest acceptable block timestamp for this purchase.
    function buy(uint256 minRchOut, uint256 deadline) external payable whenNotPaused nonReentrant {
        if (saleClosed) revert SaleClosed();
        if (block.timestamp > deadline) revert PurchaseExpired();
        if (msg.value == 0 || minRchOut == 0) revert EmptyPurchase();
        if (msg.value < MIN_PURCHASE_WEI) revert PaymentBelowMinimum(msg.value, MIN_PURCHASE_WEI);
        (uint256 rchOut, uint256 ethUsdPriceE8) = quote(msg.value);
        if (rchOut == 0) revert EmptyPurchase();
        if (rchOut < minRchOut) revert OutputBelowMinimum(rchOut, minRchOut);

        rch.mintPurchased(msg.sender, rchOut);
        _sendToTreasury(msg.value);
        emit Purchased(msg.sender, msg.value, rchOut, ethUsdPriceE8);
    }

    /// @notice Deliver any ETH sent outside a purchase to the fixed treasury.
    function withdrawProceeds() external nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) revert EmptyPurchase();
        _sendToTreasury(amount);
    }

    function _sendToTreasury(uint256 amount) private {
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TreasuryTransferFailed();
        emit ProceedsWithdrawn(treasury, amount);
    }

    /// @notice Ends primary issuance through this sale before a later public market opens.
    function closeSale() external onlyOwner {
        if (saleClosed) revert SaleClosed();
        saleClosed = true;
        emit SalePermanentlyClosed();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        if (saleClosed) revert SaleClosed();
        quote(1 ether);
        _unpause();
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }
}
