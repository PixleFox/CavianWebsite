import 'next-auth/jwt';

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: number;
    adminId?: number;
    role: string;
    type?: 'user' | 'admin' | 'password_reset';
  }
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: number;
      role: string;
      type?: 'user' | 'admin';
    } & DefaultSession['user'];
  }
}
