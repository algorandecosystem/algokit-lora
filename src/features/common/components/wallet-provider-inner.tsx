import { PropsWithChildren } from 'react'
import { useSetActiveWalletState } from '@/features/wallet/data/active-wallet'
import { useWallet, WalletProvider } from '@algorandecosystem/use-wallet-react'
import { WalletManager } from '@algorandecosystem/use-wallet'

type Props = PropsWithChildren<{
  walletManager: WalletManager
}>

function SetActiveWalletState({ children }: PropsWithChildren) {
  const { isReady, activeAddress } = useWallet()

  // No custom signer - let algokit-utils use the default
  // Transaction wizard handles all signing
  useSetActiveWalletState(isReady, activeAddress ?? undefined)

  return <>{children}</>
}

export function WalletProviderInner({ walletManager, children }: Props) {
  return (
    <WalletProvider manager={walletManager}>
      <SetActiveWalletState>{children}</SetActiveWalletState>
    </WalletProvider>
  )
}
