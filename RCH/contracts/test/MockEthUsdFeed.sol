// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEthUsdFeed} from "../interfaces/IEthUsdFeed.sol";

contract MockEthUsdFeed is IEthUsdFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable override decimals;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    string public override description = "ETH / USD";

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setAnswer(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setRound(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function setDescription(string calldata description_) external {
        description = description_;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
