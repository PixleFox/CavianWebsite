export const SuccessMessages = {
  // Auth related
  OTP_SENT: 'کد تایید با موفقیت ارسال شد',
  OTP_VERIFIED: 'احراز هویت با موفقیت انجام شد',
  LOGOUT_SUCCESS: 'شما با موفقیت از حساب کاربری خود خارج شدید',
  
  // Admin related
  ADMIN_CREATED: 'ادمین جدید با موفقیت ایجاد شد',
  ADMIN_UPDATED: 'اطلاعات ادمین با موفقیت به‌روزرسانی شد',
  ADMIN_DELETED: 'ادمین با موفقیت حذف شد',
  
  // Generic
  OPERATION_SUCCESSFUL: 'عملیات با موفقیت انجام شد',
  CHANGES_SAVED: 'تغییرات با موفقیت ذخیره شدند',
  
  // File operations
  FILE_UPLOADED: 'فایل با موفقیت آپلود شد',
  FILE_DELETED: 'فایل با موفقیت حذف شد',
  
  // User feedback
  THANKS_FOR_FEEDBACK: 'از بازخورد شما متشکریم',
  
  // Account
  PASSWORD_CHANGED: 'رمز عبور با موفقیت تغییر یافت',
  PROFILE_UPDATED: 'پروفایل با موفقیت به‌روزرسانی شد',
  
  // System
  SETTINGS_UPDATED: 'تنظیمات با موفقیت به‌روزرسانی شد',
  
  // Response helpers
  withCount: (count: number, singular: string, plural: string) => 
    `تعداد ${count} ${count > 1 ? plural : singular} با موفقیت یافت شد`,
    
  withName: (name: string, action: string) =>
    `${name} با موفقیت ${action} شد`
} as const;

export type SuccessMessage = keyof typeof SuccessMessages;
