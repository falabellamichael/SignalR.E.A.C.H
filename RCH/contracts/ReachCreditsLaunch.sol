// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReachCredits} from "./ReachCredits.sol";
import {ReachCreditsSale} from "./ReachCreditsSale.sol";
import {IEthUsdFeed} from "./interfaces/IEthUsdFeed.sol";

/// @notice Creates RCH and its paused sale atomically. The deployer receives no admin role.
contract ReachCreditsLaunch is ReachCredits {
    ReachCreditsSale public immutable initialSale;

    constructor(
        address admin,
        address payable treasury,
        IEthUsdFeed feed,
        uint256 maxOracleAge,
        uint256 minEthUsdPriceE8,
        uint256 maxEthUsdPriceE8
    ) ReachCredits(admin) {
        initialSale = new ReachCreditsSale(
            this, feed, treasury, admin, maxOracleAge, minEthUsdPriceE8, maxEthUsdPriceE8
        );
        _grantRole(SALE_MINTER_ROLE, address(initialSale));
    }
}
