// Test-only Uniswap V2 factory/router pair with the exact external interface the reviewed
// tool depends on. Production never deploys these; they let the local tests drive
// `prepareWethPool` and `verifyPoolResult` against the same ABI surface as mainnet.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockV2Pair} from "./MockV2Pair.sol";

/// @dev WETH needs `deposit()` beyond the ERC-20 surface for `addLiquidityETH`.
interface IWETHLike is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IMockFactory {
    function createPair(address, address) external returns (address);
    function getPair(address, address) external view returns (address);
}

contract MockV2Factory is IMockFactory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "MockV2Factory: IDENTICAL_ADDRESSES");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(t0 != address(0), "MockV2Factory: ZERO_ADDRESS");
        require(getPair[t0][t1] == address(0), "MockV2Factory: PAIR_EXISTS");
        pair = address(new MockV2Pair(t0, t1));
        getPair[t0][t1] = pair;
        getPair[t1][t0] = pair;
        allPairs.push(pair);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }
}

/// @dev Minimal WETH: deposit/withdraw plus ERC-20, enough for `addLiquidityETH`.
contract MockWETH is IERC20Metadata {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "MockWETH: INSUFFICIENT_BALANCE");
        balanceOf[msg.sender] -= wad;
        totalSupply -= wad;
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "MockWETH: TRANSFER_FAILED");
    }

    receive() external payable { this.deposit(); }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) private returns (bool) {
        require(balanceOf[from] >= value, "MockWETH: INSUFFICIENT_BALANCE");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract MockV2Router {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable WETH;

    constructor(address factory_, address weth_) {
        factory = factory_;
        WETH = weth_;
    }

    /// @dev Same signature and semantics as UniswapV2Router02.addLiquidityETH.
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(block.timestamp <= deadline, "MockV2Router: EXPIRED");
        IWETHLike(WETH).deposit{value: msg.value}();
        address pair = IMockFactory(factory).getPair(token, WETH);
        require(pair != address(0), "MockV2Router: PAIR_MISSING");
        IERC20(token).safeTransferFrom(msg.sender, pair, amountTokenDesired);
        IERC20(WETH).safeTransfer(pair, msg.value);
        liquidity = MockV2Pair(pair).mint(to);
        return (amountTokenDesired, msg.value, liquidity);
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256) {
        require(amountA > 0, "MockV2Router: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "MockV2Router: INSUFFICIENT_LIQUIDITY");
        return amountA * reserveB / reserveA;
    }
}