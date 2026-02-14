import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import yaml from 'js-yaml'
import { Config, ModelProfile } from './messages'

export function loadConfig(configPath: string = 'config.yaml'): Config {
  const content = readFileSync(configPath, 'utf8')
  return yaml.load(content) as Config
}

export function loadModelProfile(profilePath: string, baseDir: string = '.'): ModelProfile {
  const fullPath = join(baseDir, profilePath)
  const content = readFileSync(fullPath, 'utf8')
  return yaml.load(content) as ModelProfile
}

export function loadFullConfig(configPath: string = 'config.yaml'): { config: Config; profiles: Record<string, ModelProfile> } {
  const config = loadConfig(configPath)
  const baseDir = dirname(configPath)
  const profiles: Record<string, ModelProfile> = {}

  for (const profileRef of config.available_models) {
    // profileRef can be a path to a yaml file
    if (profileRef.endsWith('.yaml') || profileRef.endsWith('.yml')) {
      const profile = loadModelProfile(profileRef, baseDir)
      profiles[profile.name] = profile
    }
  }

  return { config, profiles }
}
