import { useEffect, useState } from 'react'
import { Pet, type DshPetConfig } from 'dsh-pet-component'

const CONFIG_URL = 'pet-asset://local/config.json'
const ASSET_BASE = 'pet-asset://local/webm'
const PET_SIZE = 462

export function App() {
  const [config, setConfig] = useState<DshPetConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch(CONFIG_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<DshPetConfig>
      })
      .then((loaded) => {
        if (!cancelled) setConfig(loaded)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <p className="pet-error">桌宠配置没加载出来：{error}</p>
  if (!config) return null

  return <Pet config={config} uri={{ default: ASSET_BASE }} size={PET_SIZE} />
}

export default App
