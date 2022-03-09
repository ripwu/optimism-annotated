/* Imports: External */
import { StateBatchAppendedEvent } from '@eth-optimism/contracts/dist/types/StateCommitmentChain'
import { getContractFactory } from '@eth-optimism/contracts'
import { BigNumber } from 'ethers'

/* Imports: Internal */
import { MissingElementError } from './errors'
import {
  StateRootBatchEntry,
  StateBatchAppendedExtraData,
  StateBatchAppendedParsedEvent,
  StateRootEntry,
  EventHandlerSet,
} from '../../../types'

export const handleEventsStateBatchAppended: EventHandlerSet<
  StateBatchAppendedEvent,
  StateBatchAppendedExtraData,
  StateBatchAppendedParsedEvent
> = {
  getExtraData: async (event) => {
    const eventBlock = await event.getBlock()
    const l1Transaction = await event.getTransaction()

    return {
      timestamp: eventBlock.timestamp,
      blockNumber: eventBlock.number,
      submitter: l1Transaction.from,
      l1TransactionHash: l1Transaction.hash,
      l1TransactionData: l1Transaction.data, // calldata
    }
  },
  parseEvent: (event, extraData) => {
    // 函数原型 function _appendBatch(bytes32[] memory _batch, bytes memory _extraData) internal;
    // 解析 calldata 参数[0](即 _batch)，得到 stateRoots
    const stateRoots = getContractFactory(
      'StateCommitmentChain'
    ).interface.decodeFunctionData(
      'appendStateBatch',
      extraData.l1TransactionData
    )[0]

    // 遍历 stateRoots 数组，得到 stateRootEntries
    const stateRootEntries: StateRootEntry[] = []
    for (let i = 0; i < stateRoots.length; i++) {
      stateRootEntries.push({
        index: event.args._prevTotalElements.add(BigNumber.from(i)).toNumber(),
        batchIndex: event.args._batchIndex.toNumber(),
        value: stateRoots[i],
        confirmed: true,
      })
    }

    // Using .toNumber() here and in other places because I want to move everything to use
    // BigNumber + hex, but that'll take a lot of work. This makes it easier in the future.
    const stateRootBatchEntry: StateRootBatchEntry = {
      index: event.args._batchIndex.toNumber(),
      blockNumber: BigNumber.from(extraData.blockNumber).toNumber(),
      timestamp: BigNumber.from(extraData.timestamp).toNumber(),
      submitter: extraData.submitter,
      size: event.args._batchSize.toNumber(),
      root: event.args._batchRoot,
      prevTotalElements: event.args._prevTotalElements.toNumber(),
      extraData: event.args._extraData, // abi.encode(block.timestamp, msg.sender)
      l1TransactionHash: extraData.l1TransactionHash,
    }

    return {
      stateRootBatchEntry,
      stateRootEntries,
    }
  },
  storeEvent: async (entry, db) => {
    // Defend against situations where we missed an event because the RPC provider
    // (infura/alchemy/whatever) is missing an event.
    if (entry.stateRootBatchEntry.index > 0) {
      const prevStateRootBatchEntry = await db.getStateRootBatchByIndex(
        entry.stateRootBatchEntry.index - 1
      )

      // We should *always* have a previous batch entry here.
      if (prevStateRootBatchEntry === null) {
        throw new MissingElementError('StateBatchAppended')
      }
    }

    await db.putStateRootBatchEntries([entry.stateRootBatchEntry])
    await db.putStateRootEntries(entry.stateRootEntries)
  },
}
