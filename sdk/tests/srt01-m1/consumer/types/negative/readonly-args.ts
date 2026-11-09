import type { ArgsOf } from '@aotui/sdk/tools';
import { edit } from '../producer.js';
export function change(args: ArgsOf<typeof edit>) { args.filePath = 'new'; args.tags.push(1); }
