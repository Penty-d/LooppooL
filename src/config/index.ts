import { Config, ModelsConfig } from '../types';
import configData from './config.json';
import modelsData from './models.json';

export function loadConfig(): Config {
  return configData as Config;
}

/**
 * 加载分级模型库配置（含调度器配置、tier 映射、供应商密钥）
 * models.json 含真实密钥，已 gitignore；首次使用请复制 models.example.json
 */
export function loadModelsConfig(): ModelsConfig {
  return modelsData as ModelsConfig;
}
