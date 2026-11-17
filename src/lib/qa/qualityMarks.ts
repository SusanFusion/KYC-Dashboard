// Display-only marks for the two team quality figures shown on the Dashboard,
// Team Performance, Overall MTD and in the exported Weekly and MTD reports.
// They never feed the Business Gate or any agent's score.

// Team QA Average color: 90% and above is green, 80% up to (not including)
// 90% is amber, below 80% is red. The check uses the same one-decimal number
// that is shown, so 89.9% reads amber and 90.0% reads green.
export const QUALITY_GREEN_MIN = 90;
export const QUALITY_AMBER_MIN = 80;

// Rejection Quality / Markdown Percentage: at or above this it is Passing
// (green); below it, Below passing mark (red).
export const REJECTION_QUALITY_PASSING_MARK = 95;
