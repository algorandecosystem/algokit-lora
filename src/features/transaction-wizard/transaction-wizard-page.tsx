import { useCallback, useState } from 'react'
import { PageTitle } from '../common/components/page-title'
import { SimulateResult, transactionGroupLabel, TransactionsBuilder } from './components/transactions-builder'
import { asTransactionFromSendResult } from '../transactions/data/send-transaction-result'
import { asTransactionsGraphData } from '../transactions-graph/mappers'
import { BuildTransactionResult, BuildableTransactionType } from './models'
import { SendTransactionResults } from '@algorandfoundation/algokit-utils/transaction'
import { SimulateResponse } from '@algorandfoundation/algokit-utils/algod-client'
import { AppCallTransaction, TransactionType } from '../transactions/models'
import { GroupSendResults, SendResults } from './components/group-send-results'
import { useTitle } from '@/utils/use-title'
import { PageLoader } from '../common/components/page-loader'
import { useLoadableSearchParamsTransactions } from '../transactions/data/use-loadable-search-params-transaction'
import { RenderLoadable } from '../common/components/render-loadable'
import { useWallet } from '@algorandecosystem/use-wallet-react'
import algosdk from 'algosdk'
import { invariant } from '@/utils/invariant'

export const transactionWizardPageTitle = 'Transaction Wizard'
export const transactionTypeLabel = 'Transaction type'
export const sendButtonLabel = 'Send'
export const simulateButtonLabel = 'Simulate'

export function TransactionWizardPage() {
  const [sendResults, setSendResults] = useState<SendResults | undefined>(undefined)
  const loadableSearchParamsTransactions = useLoadableSearchParamsTransactions()
  const { transactionSigner, activeAddress, activeWallet, algodClient } = useWallet()
  useTitle('Transaction Wizard')

  const renderTransactionResults = useCallback((result: SendTransactionResults, simulateResponse?: SimulateResponse) => {
    const sentTransactions = asTransactionFromSendResult(result)
    const transactionsGraphData = asTransactionsGraphData(sentTransactions)
    const appCallTransactions = sentTransactions.filter((txn) => txn.type === TransactionType.AppCall)
    setSendResults({
      transactionGraph: transactionsGraphData,
      sentAppCalls: appCallTransactions as unknown as AppCallTransaction[],
      simulateResponse,
    })
  }, [])

  const sendTransactionsCallback = useCallback(
    async (transactions: BuildTransactionResult[]) => {
      invariant(activeAddress, 'No active address available')
      invariant(algodClient, 'No algod client available')

      console.info('[Wallet] Using wallet:', activeWallet?.id)
      console.info('[Wallet] Processing', transactions.length, 'transactions from wizard')

      // Get suggested params from algod
      const suggestedParams = await algodClient.getTransactionParams().do()

      // Create algosdk transactions directly from the wizard data
      // This matches the working example pattern
      console.info('[Wallet] Creating algosdk transactions...')
      const algosdkTxns: algosdk.Transaction[] = []

      for (const txn of transactions) {
        const rawTxn = txn as any

        // Handle different transaction types
        if (txn.type === BuildableTransactionType.Payment) {
          // Payment transaction
          const sender = rawTxn.sender?.resolvedAddress || activeAddress
          const receiver = rawTxn.receiver?.resolvedAddress || activeAddress
          const amount = Number(rawTxn.amount || 0)

          algosdkTxns.push(
            algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender,
              receiver,
              amount,
              note: rawTxn.note ? new TextEncoder().encode(rawTxn.note) : undefined,
              suggestedParams,
            })
          )
        } else if (txn.type === BuildableTransactionType.AppCall) {
          // App call transaction
          const sender = rawTxn.sender?.resolvedAddress || activeAddress
          const appIndex = Number(rawTxn.applicationId || 0)
          const onComplete = Number(rawTxn.onComplete ?? 0)

          algosdkTxns.push(
            algosdk.makeApplicationCallTxnFromObject({
              sender,
              appIndex,
              onComplete: onComplete as algosdk.OnApplicationComplete,
              appArgs: rawTxn.args,
              accounts: rawTxn.accounts,
              foreignApps: rawTxn.foreignApps?.map(Number),
              foreignAssets: rawTxn.foreignAssets?.map(Number),
              suggestedParams,
            })
          )
        } else if (txn.type === BuildableTransactionType.AssetTransfer) {
          // Asset transfer
          const sender = rawTxn.sender?.resolvedAddress || activeAddress
          const assetIndex = Number(rawTxn.asset?.id || 0)
          const receiver = rawTxn.receiver?.resolvedAddress || activeAddress
          const amount = Number(rawTxn.amount || 0)

          algosdkTxns.push(
            algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
              sender,
              assetIndex,
              receiver,
              amount,
              suggestedParams,
            })
          )
        } else {
          // Fallback for unsupported types - create a simple 0-amount payment
          console.warn('[Wallet] Unsupported transaction type:', txn.type, '- creating placeholder transaction')
          algosdkTxns.push(
            algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender: activeAddress,
              receiver: activeAddress,
              amount: 0,
              suggestedParams,
            })
          )
        }
      }

      if (algosdkTxns.length === 0) {
        throw new Error('No transactions to send')
      }

      console.info('[Wallet] Created', algosdkTxns.length, 'algosdk transactions')

      // Sign using transactionSigner (receives algosdk Transaction[] directly)
      const indexesToSign = Array.from({ length: algosdkTxns.length }, (_, i) => i)
      console.info('[Wallet] Signing', algosdkTxns.length, 'transactions with transactionSigner...')
      const signResults = await transactionSigner(algosdkTxns, indexesToSign)

      // Check we got signatures
      const signedTxns = signResults.filter((r): r is Uint8Array => r !== null)
      console.info('[Wallet] Sent', algosdkTxns.length, 'txns to wallet, got', signedTxns.length, 'signed back')

      if (signedTxns.length === 0) {
        throw new Error('No signatures received')
      }

      // Detect if this is a Falcon24 signature based on size
      const firstSignedTxn = signedTxns[0]
      const isFalcon24 = firstSignedTxn && firstSignedTxn.length > 1000

      console.info('[Wallet] First txn size:', firstSignedTxn?.length, 'bytes')
      console.info('[Wallet] Is Falcon24:', isFalcon24)

      if (isFalcon24) {
        // If wallet returned multiple txns, log each one
        if (signedTxns.length > 1) {
          console.info('[Falcon24] Wallet returned', signedTxns.length, 'separate transactions:')
          signedTxns.forEach((txn, i) => {
            try {
              const decoded = algosdk.decodeSignedTransaction(txn)
              console.info(`  [Falcon24] Txn ${i}: type=${decoded.txn.type}, size=${txn.length} bytes, hasGroup=${!!decoded.txn.group}`)
            } catch {
              console.info(`  [Falcon24] Txn ${i}: size=${txn.length} bytes (could not decode)`)
            }
          })
        }

        // Try to decode the first one to see what's inside
        try {
          const decoded = algosdk.decodeSignedTransaction(firstSignedTxn)
          console.info('[Falcon24] Decoded txn type:', decoded.txn.type)
          console.info('[Falcon24] Decoded txn has group:', !!decoded.txn.group)
          if (decoded.txn.group) {
            console.info('[Falcon24] Group ID:', Buffer.from(decoded.txn.group).toString('base64'))
          }
        } catch (e) {
          console.info('[Falcon24] Could not decode as single txn:', e)
        }

        // Send all transactions to the node
        // If wallet returned multiple, concatenate them; otherwise send the single payload
        let payloadToSend: Uint8Array
        if (signedTxns.length === 1) {
          payloadToSend = firstSignedTxn
          console.info('[Falcon24] Sending single payload of', firstSignedTxn.length, 'bytes')
        } else {
          // Concatenate all signed transactions
          const totalLength = signedTxns.reduce((sum, txn) => sum + txn.length, 0)
          payloadToSend = new Uint8Array(totalLength)
          let offset = 0
          for (const txn of signedTxns) {
            payloadToSend.set(txn, offset)
            offset += txn.length
          }
          console.info('[Falcon24] Sending concatenated payload:', signedTxns.length, 'txns,', totalLength, 'bytes')
        }

        const sendResponse = await algodClient.sendRawTransaction(payloadToSend).do()
        const txId = typeof sendResponse === 'string' ? sendResponse : (sendResponse as unknown as { txid: string }).txid
        console.info('[Falcon24] Payload sent, txId:', txId)

        // Wait for confirmation
        const confirmation = await algosdk.waitForConfirmation(algodClient, txId, 4)
        console.info('[Falcon24] Confirmed in round:', confirmation.confirmedRound)

        // Extract info from the signed payload
        const firstDecodedTxn = algosdk.decodeSignedTransaction(firstSignedTxn)
        const groupId = firstDecodedTxn?.txn?.group
          ? Buffer.from(firstDecodedTxn.txn.group).toString('base64')
          : undefined

        // Create confirmations with genesis info from decoded transactions
        const confirmations: any[] = []
        const txIds: string[] = []
        const decodedTransactions: algosdk.Transaction[] = []

        // Decode each signed transaction to get its details
        for (let i = 0; i < signedTxns.length; i++) {
          const signedTxn = signedTxns[i]
          if (!signedTxn) continue

          try {
            const decoded = algosdk.decodeSignedTransaction(signedTxn)
            const currentTxId = decoded.txn.txID()
            txIds.push(currentTxId)
            decodedTransactions.push(decoded.txn)

            confirmations.push({
              ...confirmation,
              txn: {
                txn: {
                  ...decoded.txn,
                  txId: () => currentTxId,
                  genesisHash: decoded.txn.genesisHash,
                  genesisId: decoded.txn.genesisID,
                }
              }
            })
          } catch {
            // Fallback: use the main confirmation
            txIds.push(txId)
            decodedTransactions.push(algosdkTxns[0])
            confirmations.push({
              ...confirmation,
              txn: {
                txn: {
                  txId: () => txId,
                  genesisHash: algosdkTxns[0]?.genesisHash,
                  genesisId: algosdkTxns[0]?.genesisID,
                }
              }
            })
          }
        }

        // Create result with confirmations for UI rendering
        const result: any = {
          groupId: groupId,
          txIds: txIds,
          transactions: decodedTransactions,
          confirmations: confirmations,
        }

        renderTransactionResults(result)
      } else {
        // Standard Ed25519 flow
        console.info('[Ed25519] Sending transactions...')
        console.info('[Ed25519] Total transactions to send:', signedTxns.length)

        // For Ed25519, we can also send as a group for better consistency
        // Concatenate all signed transactions into a single byte array
        const totalLength = signedTxns.reduce((sum, txn) => sum + txn.length, 0)
        const concatenatedTxns = new Uint8Array(totalLength)
        let offset = 0
        for (const txn of signedTxns) {
          concatenatedTxns.set(txn, offset)
          offset += txn.length
        }

        console.info(`[Ed25519] Sending ${signedTxns.length} transactions as group (${totalLength} bytes)...`)

        // Send all transactions together in a single call
        const sendResponse = await algodClient.sendRawTransaction(concatenatedTxns).do()
        const txId = typeof sendResponse === 'string' ? sendResponse : (sendResponse as unknown as { txid: string }).txid
        console.info('[Ed25519] Group sent, first txId:', txId)

        // Wait for confirmation of the first transaction
        const confirmation = await algosdk.waitForConfirmation(algodClient, txId, 4)
        console.info('[Ed25519] First transaction confirmed in round:', confirmation.confirmedRound)

        // Create confirmations for all transactions
        const confirmations: any[] = []
        const txIds: string[] = []

        for (let i = 0; i < algosdkTxns.length; i++) {
          const txn = algosdkTxns[i]
          const signedTxn = signResults[i]
          if (!signedTxn) continue

          const currentTxId = signedTxn ? algosdk.decodeSignedTransaction(signedTxn).txn.txID() : undefined
          if (currentTxId) {
            txIds.push(currentTxId)
          }

          const confirmationCopy: any = { ...confirmation }
          confirmationCopy.txn = {
            txn: {
              ...((confirmation as any).txn?.txn || {}),
              genesisHash: txn.genesisHash,
              genesisId: txn.genesisID,
              txId: () => currentTxId || txId
            }
          }
          confirmations.push(confirmationCopy)
        }

        // Create result with confirmations for UI rendering
        const result: any = {
          groupId: undefined,
          txIds: txIds,
          transactions: algosdkTxns,
          confirmations: confirmations,
        }

        renderTransactionResults(result)
      }
    },
    [transactionSigner, activeAddress, activeWallet, algodClient, renderTransactionResults]
  )

  const renderSimulateResult = useCallback(
    async (result: SimulateResult) => {
      renderTransactionResults(result, result.simulateResponse)
    },
    [renderTransactionResults]
  )

  const reset = useCallback(() => {
    setSendResults(undefined)
  }, [])

  return (
    <div className="w-full space-y-2 overflow-hidden">
      <PageTitle title={transactionWizardPageTitle} />
      <div className="w-full space-y-6">
        <p>Create and send transactions to the selected network using a connected wallet.</p>

        <RenderLoadable loadable={loadableSearchParamsTransactions} fallback={<PageLoader />}>
          {(searchParamsTransactions) => (
            <TransactionsBuilder
              defaultTransactions={searchParamsTransactions.transactions}
              title={<h2 className="pb-0">{transactionGroupLabel}</h2>}
              onSendTransactions={sendTransactionsCallback}
              onSimulated={renderSimulateResult}
              onReset={reset}
            />
          )}
        </RenderLoadable>
        {sendResults && <GroupSendResults {...sendResults} transactionGraphBgClassName="bg-background" />}
      </div>
    </div>
  )
}
