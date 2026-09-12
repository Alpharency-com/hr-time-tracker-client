import { describe, it, expect } from 'vitest';
import { getAuthErrorMessage } from '../authErrors';

describe('getAuthErrorMessage()', () => {
	it('returns the disabled-account message for 403 user_disabled', () => {
		const error = {
			response: {
				status: 403,
				_data: {
					detail: 'This account has been disabled.',
					code: 'user_disabled'
				}
			}
		};

		expect(getAuthErrorMessage(error, 'Login failed. Please try again.')).toBe(
			'This account has been disabled.'
		);
	});

	it('returns invalid credentials for 400 responses', () => {
		const error = {
			response: {
				status: 400,
				_data: {
					non_field_errors: ['Unable to log in with provided credentials.']
				}
			}
		};

		expect(getAuthErrorMessage(error, 'Login failed. Please try again.')).toBe(
			'Invalid username or password'
		);
	});

	it('returns passkey not-found message for 404 responses', () => {
		const error = {
			response: {
				status: 404,
				_data: { detail: 'User not found' }
			}
		};

		expect(getAuthErrorMessage(error, 'Passkey login failed. Please try again.')).toBe(
			'User not found or no passkeys registered'
		);
	});
});
