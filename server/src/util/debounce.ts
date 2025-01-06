export function debounce (func: any, wait: number, immediate: boolean) {
	let timeout: any;

	return function executedFunction (this: any, ...args: any[]) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const context = this;

		const later = function () {
			timeout = null;
			if (!immediate) func.apply(context, args);
		};

		const callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) func.apply(context, args);
	};
}

export default debounce;