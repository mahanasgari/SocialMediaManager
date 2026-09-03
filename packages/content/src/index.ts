export { variablesIn, render, isComplete } from './template.js'
export type { RenderResult } from './template.js'

export { linksIn, tagUrl, tagText, resolvePreset, presetVariables } from './utm.js'
export type { UtmParams, TagResult } from './utm.js'

export {
  occurrencesBetween,
  nextOccurrences,
  describeRule,
  zonedTimeToUtc,
  offsetMinutes,
  localDate,
} from './recurrence.js'
export type { RecurrenceRule, Weekday } from './recurrence.js'

export { nextFreeSlots, describeSlot, SUGGESTED_SLOTS } from './queue.js'
export type { Slot } from './queue.js'
