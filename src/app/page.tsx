export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="max-w-4xl w-full text-center space-y-8">
        <h1 className="text-5xl md:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-[hsl(var(--primary))] to-[hsl(var(--primary))]/80">
          به کاویان خوش آمدید
        </h1>
        <p className="text-lg md:text-xl text-[hsl(var(--muted-foreground))] max-w-2xl mx-auto">
          این صفحه اول است ، در حال پخت و پز هستیم
        </p>
        <div className="pt-4">
          <button 
            className="px-8 py-3 rounded-lg font-medium text-white bg-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/90 transition-colors shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 duration-200"
          >
            شروع
          </button>
        </div>
      </div>
    </div>
  );
}
