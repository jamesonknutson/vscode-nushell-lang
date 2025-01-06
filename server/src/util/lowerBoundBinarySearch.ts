
export function lowerBoundBinarySearch (arr: number[], num: number): number {
	let low = 0;
	let mid = 0;
	let high = arr.length - 1;

	if (num >= arr[ high ]) return high;

	while (low < high) {
		// Bitshift to avoid floating point division
		mid = (low + high) >> 1;

		if (arr[ mid ] < num) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}

	return low - 1;
}
