import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Generate subgraph.yaml.
 *
 * A factory-only datasource indexes Safes created AFTER the start block, which for a recent
 * window is almost none: the Safes worth analysing were deployed years ago. So the manifest
 * carries both:
 *
 *   - the three SafeProxyFactory deployments, as templates, to pick up new Safes
 *   - every Safe currently on the leaderboard, as an explicit datasource, so the subgraph has
 *     real approval history for exactly the population Roll Call ranks
 *
 * Regenerate after a scan: npm run manifest
 */

const START_BLOCK = 25_600_000  // recent window: minutes to sync, not days. Coverage is stated, not implied.

const FACTORIES = [
  { name: 'SafeFactory130', address: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' },
  { name: 'SafeFactory141', address: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' },
  { name: 'SafeFactory111', address: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC' },
]

const lb = JSON.parse(readFileSync('data/leaderboard.json', 'utf8'))
const safes: string[] = lb.rows.map((r: any) => r.address)

const safeHandlers = `
      eventHandlers:
        - event: ExecutionSuccess(bytes32,uint256)
          handler: handleExecutionSuccess
          receipt: true
        - event: ExecutionFailure(bytes32,uint256)
          handler: handleExecutionFailure
          receipt: true
        - event: AddedOwner(address)
          handler: handleAddedOwner
        - event: RemovedOwner(address)
          handler: handleRemovedOwner
        - event: ChangedThreshold(uint256)
          handler: handleChangedThreshold`

const safeMapping = (entities: string) => `    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      file: ./src/safe.ts
      entities: [${entities}]
      abis:
        - name: Safe
          file: ./abis/Safe.json`

const yaml = `specVersion: 1.0.0
description: >
  Roll Call - protocol agnostic authority and recovered approval index. One schema for Ownable,
  AccessControl, EIP-1967 proxies and Safe, so a single query shape answers "who can change this
  contract, and are they still awake" for any protocol.
repository: https://github.com/divyanshkhurana06/rollcall
schema:
  file: ./schema.graphql

dataSources:
${FACTORIES.map((f) => `  - kind: ethereum/contract
    name: ${f.name}
    network: mainnet
    source:
      address: "${f.address}"
      abi: SafeProxyFactory
      startBlock: ${START_BLOCK}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      file: ./src/factory.ts
      entities: [Contract]
      abis:
        - name: SafeProxyFactory
          file: ./abis/SafeProxyFactory.json
        - name: Safe
          file: ./abis/Safe.json
      eventHandlers:
        - event: ProxyCreation(address,address)
          handler: handleProxyCreation`).join('\n')}

${safes.map((addr, i) => `  - kind: ethereum/contract
    name: Safe${i}
    network: mainnet
    source:
      address: "${addr}"
      abi: Safe
      startBlock: ${START_BLOCK}
${safeMapping('Contract, AuthorityRecord, SignerApproval, Signer, SafeExecution')}${safeHandlers}`).join('\n')}

templates:
  - kind: ethereum/contract
    name: Safe
    network: mainnet
    source:
      abi: Safe
${safeMapping('Contract, AuthorityRecord, SignerApproval, Signer, SafeExecution')}${safeHandlers}
`

writeFileSync('subgraph/subgraph.yaml', yaml)
console.log(`manifest written: ${FACTORIES.length} factories + ${safes.length} explicit Safes, from block ${START_BLOCK}`)
