// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Receives protection actions from the Roll Call CRE Confidential Workflow.
 *
 * Note what is deliberately absent: no health factor, no liquidation threshold, no emergency
 * capital balance, no governance bounds, no indication of WHICH rule fired. An observer learns
 * that a position was protected and by how much, which they would learn from the transfer anyway.
 *
 * They do not learn the strategy, which is the only part worth front running.
 */
contract LiquidationProtectionConsumer {
    enum Action { HOLD, PARTIAL_REPAY, ADD_COLLATERAL, FULL_UNWIND }

    event Protected(Action action, uint256 sizeUsdc, bytes32 commitment, uint256 at);

    address public immutable forwarder;

    Action public lastAction;
    uint256 public lastSize;
    bytes32 public lastCommitment;
    uint256 public lastAt;
    uint256 public interventions;

    error Unauthorized();

    constructor(address _forwarder) {
        forwarder = _forwarder;
    }

    function protect(uint8 action, uint256 sizeUsdc, bytes32 commitment) external {
        if (msg.sender != forwarder) revert Unauthorized();

        lastAction = Action(action);
        lastSize = sizeUsdc;
        lastCommitment = commitment;
        lastAt = block.timestamp;
        interventions += 1;

        emit Protected(Action(action), sizeUsdc, commitment, block.timestamp);
    }
}
