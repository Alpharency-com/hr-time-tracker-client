type AuthErrorBody = {
	detail?: string;
	code?: string;
	non_field_errors?: string[];
};

/** Map login/passkey API failures to user-facing messages. */
export function getAuthErrorMessage(
	error: any,
	fallback: string,
	invalidCredentialsMessage = 'Invalid username or password'
): string {
	const status = error?.response?.status;
	const data: AuthErrorBody | undefined = error?.response?._data || error?.response?.data;

	if (status === 403 || data?.code === 'user_disabled') {
		return typeof data?.detail === 'string'
			? data.detail
			: 'This account has been disabled.';
	}

	if (status === 400) {
		return invalidCredentialsMessage;
	}

	if (status === 404) {
		return 'User not found or no passkeys registered';
	}

	return fallback;
}

export async function attachJsonErrorData(error: any): Promise<any> {
	if (error?.response) {
		try {
			error.response._data = await error.response.clone().json();
		} catch {
			// Non-JSON error body — leave _data unset
		}
	}
	return error;
}
