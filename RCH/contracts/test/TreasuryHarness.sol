// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TreasuryHarness {
    address public sale;
    bool public rejectPayment;
    bool public reenter;
    bool public reentrySucceeded;

    function configure(address sale_, bool reject_, bool reenter_) external {
        sale = sale_;
        rejectPayment = reject_;
        reenter = reenter_;
    }

    receive() external payable {
        require(!rejectPayment, "rejected");
        if (reenter) {
            (reentrySucceeded,) = sale.call(abi.encodeWithSignature("withdrawProceeds()"));
        }
    }
}
