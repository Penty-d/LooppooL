import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Config, ModelsConfig } from '../types';
import configData from './config.json';

const here = dirname(fileURLToPath(import.meta.url));

export function loadConfig(): Config {
  return configData as Config;
}

/**
 * 加载分级模型库配置（含调度器配置、tier 映射、供应商密钥）。
 * models.json 含真实密钥、已 gitignore；不存在时回退到 models.example.json（占位 key）。
 * 这样全新 checkout 也能编译/跑测试，真正运行时 ModelRegistry 会对占位 key 报出清晰错误。
 */
export function loadModelsConfig(): ModelsConfig {
  const real = resolve(here, './models.json');
  const src = existsSync(real) ? real : resolve(here, './models.example.json');
  return JSON.parse(readFileSync(src, 'utf-8')) as ModelsConfig;
}
