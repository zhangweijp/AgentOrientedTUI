import { useContext } from 'preact/hooks';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';

/** Read one value from the application launch configuration. */
export function useAppEnv<T = string>(key: string): T | undefined {
  const context = useContext(AppRuntimeContext);
  return context?.launchConfig?.[key] as T | undefined;
}
