import { createLabel } from './createLabel';

export async function durationLogWrapper<T> (name: string, fn: (label: string) => Promise<T>): Promise<T> {
	console.log('Triggered ' + name + ': ...');
	const label = createLabel(name);
	console.time(label);
	const result = await fn(label);

	// This purposefully has the same prefix length as the "Triggered " log above,
	// also does not add a newline at the end.
	process.stdout.write('Finished  ');
	console.timeEnd(label);
	return new Promise<T>((resolve) => resolve(result));
}
