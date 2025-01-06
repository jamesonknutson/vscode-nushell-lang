
export function createLabel (name: string): string {
	return `${name}#${labelid++}`;
}export let labelid = 0

