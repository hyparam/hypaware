import type { createCommandRegistry } from '../registry/commands.js'
import type { InitFlags, PickerExport, PickerExportOrigin } from './types.d.ts'

export declare function registerCoreCommands(
  registry: ReturnType<typeof createCommandRegistry>
): void

export declare function resolveInitExportChoice(
  flags: InitFlags
): { exportChoice: PickerExport; origin: PickerExportOrigin }
