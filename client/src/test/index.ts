/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as glob from 'glob'
import * as Mocha from 'mocha'
import * as path from 'path'

export function run(): Promise<void> {
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
	})
	mocha.timeout(100000)

	const testsRoot = __dirname

	return new Promise((resolve, reject) => {
		glob('**.test.js', { cwd: testsRoot }, (err, files) => {
			if (err) {
				return reject(err)
			}

			// Add files to the test suite
			for (const file of files) {
				mocha.addFile(path.resolve(testsRoot, file))
			}

			try {
				// Run the mocha test
				mocha.run((failures) => {
					if (failures > 0) {
						reject(new Error(`${failures} tests failed.`))
					} else {
						resolve()
					}
				})
			} catch (err) {
				console.error(err)
				reject(err)
			}
		})
	})
}
