// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Receives control-surface breach flags from the Roll Call CRE Confidential Workflow.
 *
 * Note what is NOT here: no protocol addresses, no signer addresses, no thresholds, no liveness
 * numbers. The chain learns that N watched control surfaces degraded past someone's tolerance,
 * plus a commitment that lets the subscriber prove afterwards which reports drove the decision.
 *
 * The exposure map stays inside the enclave, which is the entire point.
 */
contract RollCallConsumer {
    event ControlSurfaceBreach(uint256 count, bytes32 commitment, uint256 at);

    address public immutable forwarder;
    uint256 public lastCount;
    bytes32 public lastCommitment;
    uint256 public lastAt;

    error Unauthorized();

    constructor(address _forwarder) {
        forwarder = _forwarder;
    }

    function reportBreach(uint256 count, bytes32 commitment) external {
        if (msg.sender != forwarder) revert Unauthorized();
        lastCount = count;
        lastCommitment = commitment;
        lastAt = block.timestamp;
        emit ControlSurfaceBreach(count, commitment, block.timestamp);
    }
}
