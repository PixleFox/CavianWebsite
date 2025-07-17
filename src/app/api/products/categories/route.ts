import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { authenticateRequest } from '@lib/api-utils';
import { isRateLimited } from '@lib/rate-limiter';

console.log('Categories route handler loaded');

// Schema for category creation/update
const categorySchema = z.object({
  name: z.string().min(1, 'عنوان دسته‌بندی الزامی است'),
  slug: z.string().min(1, 'شناسه دسته‌بندی الزامی است').regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'شناسه دسته‌بندی معتبر نیست (فقط حروف کوچک، اعداد و خط تیره مجاز است)'
  ),
  description: z.string().optional().nullable(),
  parentId: z.string().uuid('شناسه والد نامعتبر است').optional().nullable(),
  isActive: z.boolean().default(true),
  image: z.string().url('آدرس تصویر معتبر نیست').optional().nullable(),
  bannerImage: z.string().url('آدرس بنر معتبر نیست').optional().nullable(),
  order: z.number().int().min(0).default(0),
  featured: z.boolean().default(false),
});

// GET: Get all categories
export async function GET(request: NextRequest) {
  try {
    // Check rate limiting
    console.log('Checking rate limit...');
    const rateLimit = await isRateLimited(request, 'categories:get');
    console.log('Rate limit check result:', rateLimit);
    
    if (rateLimit && rateLimit.isLimited) {
      console.log('Rate limited:', rateLimit);
      return NextResponse.json(
        { 
          success: false, 
          error: 'تعداد درخواست‌ها بیش از حد مجاز است',
          retryAfter: rateLimit.retryAfter
        },
        { status: 429 }
      );
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get('includeInactive') === 'true';
    const parentOnly = searchParams.get('parentOnly') === 'true';
    const featuredOnly = searchParams.get('featuredOnly') === 'true';
    const limit = Number(searchParams.get('limit')) || undefined;
    const page = Number(searchParams.get('page')) || 1;
    const skip = (page - 1) * (limit || 0);

    // Define the where clause type
    interface CategoryWhereInput {
      isActive?: boolean;
      parentId?: null;
      featured?: boolean;
    }
    
    // Build the where clause
    const where: CategoryWhereInput = {};
    
    if (!includeInactive) {
      where.isActive = true;
    }
    
    if (parentOnly) {
      where.parentId = null;
    }
    
    if (featuredOnly) {
      where.featured = true;
    }

    // Get total count for pagination
    const total = await prisma.category.count({ where });
    
    // Get categories with relationships
    const categories = await prisma.category.findMany({
      where,
      orderBy: [
        { order: 'asc' },
        { name: 'asc' }
      ],
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            slug: true,
            image: true
          }
        },
        children: {
          select: {
            id: true,
            name: true,
            slug: true,
            image: true,
            isActive: true,
            _count: {
              select: { products: true }
            }
          },
          orderBy: [
            { order: 'asc' },
            { name: 'asc' }
          ]
        },
        _count: {
          select: { 
            products: true,
            children: true
          }
        }
      },
      skip,
      take: limit,
    });

    // Transform the data to a more client-friendly format
    const transformedCategories = categories.map(category => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      image: category.image,
      bannerImage: category.bannerImage,
      isActive: category.isActive,
      featured: category.featured,
      order: category.order,
      parent: category.parent,
      children: category.children,
      productCount: category._count.products,
      childrenCount: category._count.children,
      hasChildren: category._count.children > 0
    }));

    return NextResponse.json({ 
      success: true, 
      data: transformedCategories,
      meta: {
        total,
        page,
        limit: limit || total,
        totalPages: limit ? Math.ceil(total / limit) : 1
      }
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'خطا در دریافت دسته‌بندی‌ها',
        ...(process.env.NODE_ENV === 'development' && { 
          details: error instanceof Error ? error.message : 'Unknown error' 
        })
      },
      { status: 500 }
    );
  }
}

// Schema for category update (partial)
const updateCategorySchema = categorySchema.partial();

// PATCH: Partially update a category
export async function PATCH(request: NextRequest) {
  try {
    // Check rate limiting
    const rateLimit = await isRateLimited(request, 'categories:update');
    if (rateLimit?.isLimited) {
      return NextResponse.json(
        { success: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' },
        { status: 429 }
      );
    }

    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success || (auth.role !== 'ADMIN' && auth.role !== 'OWNER')) {
      return NextResponse.json(
        { success: false, error: 'دسترسی غیرمجاز' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('id');
    
    if (!categoryId) {
      return NextResponse.json(
        { success: false, error: 'شناسه دسته‌بندی الزامی است' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const validation = updateCategorySchema.safeParse(body);
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'داده‌های ورودی نامعتبر است',
          details: validation.error.format() 
        },
        { status: 400 }
      );
    }

    // Check if category exists
    const existingCategory = await prisma.category.findUnique({
      where: { id: categoryId }
    });

    if (!existingCategory) {
      return NextResponse.json(
        { success: false, error: 'دسته‌بندی مورد نظر یافت نشد' },
        { status: 404 }
      );
    }

    // Check if slug is being updated and if it's already taken
    if (validation.data.slug && validation.data.slug !== existingCategory.slug) {
      const slugExists = await prisma.category.findFirst({
        where: {
          slug: validation.data.slug,
          id: { not: categoryId }
        }
      });

      if (slugExists) {
        return NextResponse.json(
          { success: false, error: 'این شناسه قبلا استفاده شده است' },
          { status: 400 }
        );
      }
    }

    // Update the category
    const updatedCategory = await prisma.category.update({
      where: { id: categoryId },
      data: {
        ...validation.data,
        // Ensure parentId is set to null if empty string is provided
        parentId: validation.data.parentId === '' ? null : validation.data.parentId
      }
    });

    return NextResponse.json({
      success: true,
      data: updatedCategory
    });

  } catch (error) {
    console.error('Error updating category:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'خطا در به‌روزرسانی دسته‌بندی',
        ...(process.env.NODE_ENV === 'development' && { 
          details: error instanceof Error ? error.message : 'Unknown error' 
        })
      },
      { status: 500 }
    );
  }
}

// PUT: Replace a category (full update)
export async function PUT(request: NextRequest) {
  try {
    // Check rate limiting
    const rateLimit = await isRateLimited(request, 'categories:update');
    if (rateLimit?.isLimited) {
      return NextResponse.json(
        { success: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' },
        { status: 429 }
      );
    }

    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success || (auth.role !== 'ADMIN' && auth.role !== 'OWNER')) {
      return NextResponse.json(
        { success: false, error: 'دسترسی غیرمجاز' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('id');
    
    if (!categoryId) {
      return NextResponse.json(
        { success: false, error: 'شناسه دسته‌بندی الزامی است' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const validation = categorySchema.safeParse(body);
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'داده‌های ورودی نامعتبر است',
          details: validation.error.format() 
        },
        { status: 400 }
      );
    }

    // Check if category exists
    const existingCategory = await prisma.category.findUnique({
      where: { id: categoryId }
    });

    if (!existingCategory) {
      return NextResponse.json(
        { success: false, error: 'دسته‌بندی مورد نظر یافت نشد' },
        { status: 404 }
      );
    }

    // Check if slug is being updated and if it's already taken
    if (validation.data.slug !== existingCategory.slug) {
      const slugExists = await prisma.category.findFirst({
        where: {
          slug: validation.data.slug,
          id: { not: categoryId }
        }
      });

      if (slugExists) {
        return NextResponse.json(
          { success: false, error: 'این شناسه قبلا استفاده شده است' },
          { status: 400 }
        );
      }
    }

    // Replace the category
    const updatedCategory = await prisma.category.update({
      where: { id: categoryId },
      data: {
        name: validation.data.name,
        slug: validation.data.slug,
        description: validation.data.description ?? null,
        parentId: validation.data.parentId || null,
        isActive: validation.data.isActive,
        image: validation.data.image ?? null,
        bannerImage: validation.data.bannerImage ?? null,
        order: validation.data.order,
        featured: validation.data.featured
      }
    });

    return NextResponse.json({
      success: true,
      data: updatedCategory
    });

  } catch (error) {
    console.error('Error replacing category:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'خطا در به‌روزرسانی دسته‌بندی',
        ...(process.env.NODE_ENV === 'development' && { 
          details: error instanceof Error ? error.message : 'Unknown error' 
        })
      },
      { status: 500 }
    );
  }
}

// DELETE: Delete a category
export async function DELETE(request: NextRequest) {
  try {
    // Check rate limiting
    const rateLimit = await isRateLimited(request, 'categories:delete');
    if (rateLimit?.isLimited) {
      return NextResponse.json(
        { success: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است' },
        { status: 429 }
      );
    }

    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success || (auth.role !== 'ADMIN' && auth.role !== 'OWNER')) {
      return NextResponse.json(
        { success: false, error: 'دسترسی غیرمجاز' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('id');
    
    if (!categoryId) {
      return NextResponse.json(
        { success: false, error: 'شناسه دسته‌بندی الزامی است' },
        { status: 400 }
      );
    }

    // Check if category exists
    const existingCategory = await prisma.category.findUnique({
      where: { id: categoryId },
      include: {
        _count: {
          select: { products: true, children: true }
        }
      }
    });

    if (!existingCategory) {
      return NextResponse.json(
        { success: false, error: 'دسته‌بندی مورد نظر یافت نشد' },
        { status: 404 }
      );
    }

    // Prevent deletion if category has products or subcategories
    if (existingCategory._count.products > 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'امکان حذف دسته‌بندی حاوی محصول وجود ندارد',
          details: 'این دسته‌بندی حاوی محصول است. لطفا ابتدا محصولات را حذف کنید.'
        },
        { status: 400 }
      );
    }

    if (existingCategory._count.children > 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'امکان حذف دسته‌بندی دارای زیردسته وجود ندارد',
          details: 'این دسته‌بندی دارای زیردسته است. لطفا ابتدا زیردسته‌ها را حذف یا منتقل کنید.'
        },
        { status: 400 }
      );
    }

    // Delete the category
    await prisma.category.delete({
      where: { id: categoryId }
    });

    return NextResponse.json({
      success: true,
      message: 'دسته‌بندی با موفقیت حذف شد'
    });

  } catch (error) {
    console.error('Error deleting category:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'خطا در حذف دسته‌بندی',
        ...(process.env.NODE_ENV === 'development' && { 
          details: error instanceof Error ? error.message : 'Unknown error' 
        })
      },
      { status: 500 }
    );
  }
}

// POST: Create a new category
export async function POST(request: NextRequest) {
  try {
    // Check rate limiting
    console.log('Checking rate limit...');
    const rateLimit = await isRateLimited(request, 'categories:create');
    console.log('Rate limit check result:', rateLimit);
    
    if (rateLimit && rateLimit.isLimited) {
      console.log('Rate limited:', rateLimit);
      return NextResponse.json(
        { 
          success: false, 
          error: 'تعداد درخواست‌ها بیش از حد مجاز است',
          retryAfter: rateLimit.retryAfter
        },
        { status: 429 }
      );
    }

    // Authenticate the request
    console.log('Authenticating request...');
    const auth = await authenticateRequest(request);
    console.log('Auth result:', { success: auth.success, role: auth.role });
    
    if (!auth.success || (auth.role !== 'ADMIN' && auth.role !== 'OWNER')) {
      console.log('Authentication failed or not authorized (requires ADMIN or OWNER)');
      return NextResponse.json(
        { success: false, error: 'دسترسی غیرمجاز. فقط مدیران سیستم می‌توانند دسته‌بندی ایجاد کنند.' },
        { status: 403 }
      );
    }

    // Validate request body
    console.log('Parsing request body...');
    let body;
    try {
      body = await request.json();
      console.log('Request body:', JSON.stringify(body, null, 2));
    } catch (error) {
      console.error('Error parsing JSON:', error);
      return NextResponse.json(
        { success: false, error: 'فرمت درخواست نامعتبر است' },
        { status: 400 }
      );
    }
    
    console.log('Validating request data...');
    const validation = categorySchema.safeParse(body);
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'داده‌های ورودی نامعتبر است',
          details: validation.error.format() 
        },
        { status: 400 }
      );
    }

    // Check if slug already exists
    console.log('Checking for existing category with slug:', validation.data.slug);
    let existingCategory;
    try {
      existingCategory = await prisma.category.findUnique({
        where: { slug: validation.data.slug },
      });
      console.log('Existing category check result:', existingCategory ? 'exists' : 'not found');
    } catch (error) {
      console.error('Database error during slug check:', error);
      return NextResponse.json(
        { success: false, error: 'خطا در بررسی تکراری نبودن شناسه' },
        { status: 500 }
      );
    }

    if (existingCategory) {
      return NextResponse.json(
        { success: false, error: 'شناسه دسته‌بندی تکراری است' },
        { status: 400 }
      );
    }

    // Create the category
    console.log('Creating new category...');
    let category;
    try {
      category = await prisma.category.create({
        data: {
          name: validation.data.name,
          slug: validation.data.slug,
          description: validation.data.description || null,
          parentId: validation.data.parentId || null,
          isActive: validation.data.isActive,
          image: validation.data.image || null,
          bannerImage: validation.data.bannerImage || null,
          order: validation.data.order,
          featured: validation.data.featured || false,
        },
      });
      console.log('Category created successfully:', category);
    } catch (error: unknown) {
      console.error('Error creating category:', error);
      const errorMessage = error instanceof Error ? error.message : 'خطای ناشناخته';
      return NextResponse.json(
        { 
          success: false, 
          error: 'خطا در ایجاد دسته‌بندی',
          details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { success: true, data: category },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating category:', error);
    return NextResponse.json(
      { success: false, error: 'خطا در ایجاد دسته‌بندی' },
      { status: 500 }
    );
  }
}
