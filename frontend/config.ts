import { join, dirname } from 'path'
import yaml from 'js-yaml'
import { Config, ModelProfile } from './messages'

export async function loadConfig(configPath: string = 'config.yaml'): Promise<Config> {
  const file = Bun.file(configPath)
  const content = await file.text()
  return yaml.load(content) as Config
}

export async function loadModelProfile(profilePath: string, baseDir: string = '.'): Promise<ModelProfile> {
  const fullPath = join(baseDir, profilePath)
  const file = Bun.file(fullPath)
  const content = await file.text()
  return yaml.load(content) as ModelProfile
}

export async function loadFullConfig(configPath: string = 'config.yaml'): Promise<{ config: Config; profiles: Record<string, ModelProfile> }> {
  const config = await loadConfig(configPath)
  const baseDir = dirname(configPath)
  const profiles: Record<string, ModelProfile> = {}

  for (const profileRef of config.available_models) {
    if (profileRef.endsWith('.yaml') || profileRef.endsWith('.yml')) {
      const profile = await loadModelProfile(profileRef, baseDir)
      profiles[profile.name] = profile
    }
  }

  return { config, profiles }
}
