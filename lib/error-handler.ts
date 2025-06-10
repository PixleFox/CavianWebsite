import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

type ErrorCode = 
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMIT_EXCEEDED'
  | 'TOO_MANY_REQUESTS'
  | 'INVALID_INPUT'
  | 'SERVER_ERROR';

interface AppError extends Error {
  code: ErrorCode;
  statusCode: number;
  details?: unknown;
  issues?: Array<{ message: string; path: string[] }>;
}

const errorMessages: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'خطا در اعتبارسنجی داده‌ها',
  AUTHENTICATION_ERROR: 'احراز هویت ناموفق بود',
  AUTHORIZATION_ERROR: 'شما مجوز دسترسی به این منبع را ندارید',
  NOT_FOUND: 'منبع درخواستی یافت نشد',
  RATE_LIMIT_EXCEEDED: 'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً دقایقی دیگر تلاش کنید',
  TOO_MANY_REQUESTS: 'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً دقایقی دیگر تلاش کنید',
  INVALID_INPUT: 'داده‌های ارسالی نامعتبر است',
  SERVER_ERROR: 'خطای سرور. لطفاً با پشتیبانی تماس بگیرید'
};

export function createError(
  code: ErrorCode,
  message?: string,
  statusCode: number = 500,
  details?: unknown
): AppError {
  const error = new Error(message || errorMessages[code]) as AppError;
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

type ErrorWithDetails = Error & {
  code?: ErrorCode;
  statusCode?: number;
  details?: unknown;
  issues?: Array<{ message: string; path: string[] }>;
  stack?: string;
};

export function handleError(
  error: unknown,
  req: NextRequest
): NextResponse {
  // Default to server error
  let statusCode = 500;
  let errorCode: ErrorCode = 'SERVER_ERROR';
  let message = errorMessages.SERVER_ERROR;
  let details: unknown = undefined;

  // Handle known error types
  const typedError = error as ErrorWithDetails;
  if (typedError.code && typedError.statusCode) {
    statusCode = typedError.statusCode;
    errorCode = typedError.code;
    message = typedError.message || errorMessages[errorCode] || message;
    details = typedError.details;
  }
  // Handle Zod validation errors
  else if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') {
    const zodError = error as { issues?: Array<{ message: string; path: string[] }> };
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'خطا در اعتبارسنجی داده‌ها';
    details = zodError.issues;
  }

  // Log the error
  console.error(`[${new Date().toISOString()}] Error: ${errorCode}`, {
    message: 'message' in typedError ? String(typedError.message) : 'Unknown error',
    stack: process.env.NODE_ENV === 'development' && 'stack' in typedError ? String(typedError.stack) : undefined,
    url: req.url,
    method: req.method,
    ip: req.headers.get('x-forwarded-for'),
    details: details || ('details' in typedError ? typedError.details : undefined)
  });

  // Prepare response
  const responseData: {
    success: boolean;
    error: string;
    code?: string;
    details?: unknown;
  } = {
    success: false,
    error: message
  };

  // Add details in development
  if (process.env.NODE_ENV === 'development') {
    responseData.code = errorCode;
    if (details) responseData.details = details;
  }

  return NextResponse.json(responseData, { status: statusCode });
}

// Helper functions for common errors
export const Errors = {
  validation: (details?: unknown) => 
    createError('VALIDATION_ERROR', undefined, 400, details),
  
  authentication: (message?: string) => 
    createError('AUTHENTICATION_ERROR', message, 401),
    
  authorization: (message?: string) => 
    createError('AUTHORIZATION_ERROR', message, 403),
    
  notFound: (message?: string) => 
    createError('NOT_FOUND', message, 404),
    
  rateLimit: () => 
    createError('RATE_LIMIT_EXCEEDED', 'تعداد درخواست‌ها بیش از حد مجاز است', 429),
    
  tooManyRequests: (message?: string) =>
    createError('TOO_MANY_REQUESTS', message || 'تعداد درخواست‌های شما بیش از حد مجاز است', 429),
    
  invalidInput: (details?: unknown) =>
    createError('INVALID_INPUT', undefined, 400, details),
    
  server: (error?: Error) =>
    createError('SERVER_ERROR', error?.message, 500, error?.stack)
};
