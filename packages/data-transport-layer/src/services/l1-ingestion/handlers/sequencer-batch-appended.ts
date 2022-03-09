/* Imports: External */
import { BigNumber, ethers, constants } from 'ethers'
import { getContractFactory } from '@eth-optimism/contracts'
import {
  fromHexString,
  toHexString,
  toRpcHexString,
} from '@eth-optimism/core-utils'
import { SequencerBatchAppendedEvent } from '@eth-optimism/contracts/dist/types/CanonicalTransactionChain'

/* Imports: Internal */
import { MissingElementError } from './errors'
import {
  DecodedSequencerBatchTransaction,
  SequencerBatchAppendedExtraData,
  SequencerBatchAppendedParsedEvent,
  TransactionBatchEntry,
  TransactionEntry,
  EventHandlerSet,
} from '../../../types'
import { parseSignatureVParam } from '../../../utils'

export const handleEventsSequencerBatchAppended: EventHandlerSet<
  SequencerBatchAppendedEvent,
  SequencerBatchAppendedExtraData,
  SequencerBatchAppendedParsedEvent
> = {
  getExtraData: async (event, l1RpcProvider) => {
    const l1Transaction = await event.getTransaction()
    const eventBlock = await event.getBlock()

    // TODO: We need to update our events so that we actually have enough information to parse this
    // batch without having to pull out this extra event. For the meantime, we need to find this
    // "TransactionBatchAppended" event to get the rest of the data.
    const CanonicalTransactionChain = getContractFactory(
      'CanonicalTransactionChain'
    )
      .attach(event.address)
      .connect(l1RpcProvider)

    // 当前事件 event 的 topic 是 SequencerBatchAppended
    // CanonicalTransactionChain.sol 在触发 SequencerBatchAppended 前，还会触发 TransactionBatchAppended
    const batchSubmissionEvent = (
      await CanonicalTransactionChain.queryFilter(
        CanonicalTransactionChain.filters.TransactionBatchAppended(),
        eventBlock.number,
        eventBlock.number
      )
    ).find((foundEvent: ethers.Event) => {
      // We might have more than one event in this block, so we specifically want to find a
      // "TransactionBatchAppended" event emitted immediately before the event in question.
      return (
        foundEvent.transactionHash === event.transactionHash &&
        foundEvent.logIndex === event.logIndex - 1 // -1 参考上面注释
      )
    })

    if (!batchSubmissionEvent) {
      throw new Error(
        `Well, this really shouldn't happen. A SequencerBatchAppended event doesn't have a corresponding TransactionBatchAppended event.`
      )
    }

    return {
      timestamp: eventBlock.timestamp,
      blockNumber: eventBlock.number,
      submitter: l1Transaction.from,
      l1TransactionHash: l1Transaction.hash,
      l1TransactionData: l1Transaction.data,

      prevTotalElements: batchSubmissionEvent.args._prevTotalElements,
      batchIndex: batchSubmissionEvent.args._batchIndex,
      batchSize: batchSubmissionEvent.args._batchSize,
      batchRoot: batchSubmissionEvent.args._batchRoot,
      batchExtraData: batchSubmissionEvent.args._extraData,
    }
  },
  parseEvent: (event, extraData, l2ChainId) => {
    const transactionEntries: TransactionEntry[] = []

    // It's easier to deal with this data if it's a Buffer.
    const calldata = fromHexString(extraData.l1TransactionData)

    if (calldata.length < 12) {
      throw new Error(
        `Block ${extraData.blockNumber} transaction data is invalid for decoding: ${extraData.l1TransactionData} , ` +
          `converted buffer length is < 12.`
      )
    }

    // 解析头部 numContexts
    const numContexts = BigNumber.from(calldata.slice(12, 15)).toNumber()
    let transactionIndex = 0
    let enqueuedCount = 0

    // sequence tx 起始地址
    let nextTxPointer = 15 + 16 * numContexts

    // 遍历 contexts
    for (let i = 0; i < numContexts; i++) {
      const contextPointer = 15 + 16 * i

      // 解析 context
      const context = parseSequencerBatchContext(calldata, contextPointer)

      // 先处理 context 内的 L1->L2 交易
      for (let j = 0; j < context.numSequencedTransactions; j++) {
        // 根据 LV 格式，取出 tx 数据
        const sequencerTransaction = parseSequencerBatchTransaction(
          calldata,
          nextTxPointer
        )

        // 反序列化 tx 数据
        const decoded = decodeSequencerBatchTransaction(
          sequencerTransaction,
          l2ChainId
        )

        transactionEntries.push({
          index: extraData.prevTotalElements
            .add(BigNumber.from(transactionIndex))
            .toNumber(),
          batchIndex: extraData.batchIndex.toNumber(),

          // 理解 如果 context 内包含 L2->L2 交易，那么 context.blockNumber 一定是 L2->L2 交易的 blockNumber
          blockNumber: BigNumber.from(context.blockNumber).toNumber(),
          timestamp: BigNumber.from(context.timestamp).toNumber(),

          gasLimit: BigNumber.from(0).toString(),
          target: constants.AddressZero,
          origin: null,
          data: toHexString(sequencerTransaction),
          queueOrigin: 'sequencer',
          value: decoded.value,
          queueIndex: null,
          decoded,
          confirmed: true,
        })

        nextTxPointer += 3 + sequencerTransaction.length

        // 更新全局交易索引
        transactionIndex++
      }

      // 再处理 context 内的 L1->L2 交易
      for (let j = 0; j < context.numSubsequentQueueTransactions; j++) {
        const queueIndex = event.args._startingQueueIndex.add(
          BigNumber.from(enqueuedCount)
        )

        // Okay, so. Since events are processed in parallel, we don't know if the Enqueue
        // event associated with this queue element has already been processed. So we'll ask
        // the api to fetch that data for itself later on and we use fake values for some
        // fields. The real TODO here is to make sure we fix this data structure to avoid ugly
        // "dummy" fields.
        transactionEntries.push({
          index: extraData.prevTotalElements
            .add(BigNumber.from(transactionIndex))
            .toNumber(),
          batchIndex: extraData.batchIndex.toNumber(),
          timestamp: context.timestamp,

          // dummy 临时数据，使用中不直接暴露，而是通过 TransportDB 的 查询函数
          // 在 TransportDB 查询函数内，通过 _makeFullTransaction() 根据 queueIndex 获取对应数据进行填充
          blockNumber: BigNumber.from(0).toNumber(),
          gasLimit: BigNumber.from(0).toString(),
          target: constants.AddressZero,
          origin: constants.AddressZero,
          data: '0x',

          queueOrigin: 'l1',
          value: '0x0',
          queueIndex: queueIndex.toNumber(),
          decoded: null,
          confirmed: true,
        })

        // 更新 L1->L2 交易索引
        enqueuedCount++

        // 更新全局交易索引
        transactionIndex++
      }
    }

    const transactionBatchEntry: TransactionBatchEntry = {
      index: extraData.batchIndex.toNumber(),
      root: extraData.batchRoot,
      size: extraData.batchSize.toNumber(),
      prevTotalElements: extraData.prevTotalElements.toNumber(),
      extraData: extraData.batchExtraData,
      blockNumber: BigNumber.from(extraData.blockNumber).toNumber(),
      timestamp: BigNumber.from(extraData.timestamp).toNumber(),
      submitter: extraData.submitter,
      l1TransactionHash: extraData.l1TransactionHash,
    }

    return {
      transactionBatchEntry,
      transactionEntries,
    }
  },
  storeEvent: async (entry, db) => {
    // Defend against situations where we missed an event because the RPC provider
    // (infura/alchemy/whatever) is missing an event.
    if (entry.transactionBatchEntry.index > 0) {
      const prevTransactionBatchEntry = await db.getTransactionBatchByIndex(
        entry.transactionBatchEntry.index - 1
      )

      // We should *always* have a previous transaction batch here.
      if (prevTransactionBatchEntry === null) {
        throw new MissingElementError('SequencerBatchAppended')
      }
    }

    await db.putTransactionBatchEntries([entry.transactionBatchEntry])
    await db.putTransactionEntries(entry.transactionEntries)

    // Add an additional field to the enqueued transactions in the database
    // if they have already been confirmed
    for (const transactionEntry of entry.transactionEntries) {
      if (transactionEntry.queueOrigin === 'l1') {
        // 建立 queueIndex 到 txIndex 的映射
        await db.putTransactionIndexByQueueIndex(
          transactionEntry.queueIndex,
          transactionEntry.index
        )
      }
    }
  },
}

interface SequencerBatchContext {
  numSequencedTransactions: number
  numSubsequentQueueTransactions: number
  timestamp: number
  blockNumber: number
}

const parseSequencerBatchContext = (
  calldata: Buffer,
  offset: number
): SequencerBatchContext => {
  return {
    // 3
    numSequencedTransactions: BigNumber.from(
      calldata.slice(offset, offset + 3)
    ).toNumber(),

    // 3
    numSubsequentQueueTransactions: BigNumber.from(
      calldata.slice(offset + 3, offset + 6)
    ).toNumber(),

    // 5
    timestamp: BigNumber.from(
      calldata.slice(offset + 6, offset + 11)
    ).toNumber(),

    // 5
    blockNumber: BigNumber.from(
      calldata.slice(offset + 11, offset + 16)
    ).toNumber(),
  }
}

// LV 格式
const parseSequencerBatchTransaction = (
  calldata: Buffer,
  offset: number
): Buffer => {
  // 3 字节长度
  const transactionLength = BigNumber.from(
    calldata.slice(offset, offset + 3)
  ).toNumber()

  // 按长度取 slice
  return calldata.slice(offset + 3, offset + 3 + transactionLength)
}

const decodeSequencerBatchTransaction = (
  transaction: Buffer,
  l2ChainId: number
): DecodedSequencerBatchTransaction => {
  const decodedTx = ethers.utils.parseTransaction(transaction)

  return {
    nonce: BigNumber.from(decodedTx.nonce).toString(),
    gasPrice: BigNumber.from(decodedTx.gasPrice).toString(),
    gasLimit: BigNumber.from(decodedTx.gasLimit).toString(),
    value: toRpcHexString(decodedTx.value),
    target: decodedTx.to ? toHexString(decodedTx.to) : null,
    data: toHexString(decodedTx.data),
    sig: {
      v: parseSignatureVParam(decodedTx.v, l2ChainId),
      r: toHexString(decodedTx.r),
      s: toHexString(decodedTx.s),
    },
  }
}
