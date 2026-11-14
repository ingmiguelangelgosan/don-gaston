import { DomainError } from '../domain/errors.ts';

export class StorageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** Do not propagate SQL, filesystem paths or financial values in error messages. */
export function storageError(error: unknown): Error {
  if (error instanceof StorageError || error instanceof DomainError)
    return error;
  const native = error as { errcode?: number; code?: string } | null;
  const primary =
    typeof native?.errcode === 'number' ? native.errcode & 255 : undefined;
  if (primary === 5 || primary === 6) return new StorageError('STORAGE_BUSY');
  if (primary === 11 || primary === 26 || primary === 19)
    return new StorageError('STORAGE_CORRUPT');
  if (primary === 13 || primary === 18)
    return new StorageError('STORAGE_LIMIT');
  if (primary === 8) return new StorageError('STORAGE_READ_ONLY');
  if (native?.code === 'EEXIST')
    return new StorageError('STORAGE_DESTINATION_EXISTS');
  return new StorageError('STORAGE_IO');
}
