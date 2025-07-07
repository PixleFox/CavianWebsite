import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import prisma from './prisma';


const UPLOAD_DIR = process.env.UPLOAD_DIR || './public/uploads';

// Define folder structure based on file types
const FOLDERS = {
  image: 'images',
  video: 'videos',
  audio: 'audio',
  document: 'documents',
  archive: 'archives',
  other: 'files'
} as const;

// Map MIME types to folder names
const MIME_TO_FOLDER: Record<string, string> = {
  // Images
  'image/': FOLDERS.image,
  // Videos
  'video/': FOLDERS.video,
  // Audio
  'audio/': FOLDERS.audio,
  // Documents
  'application/pdf': FOLDERS.document,
  'application/msword': FOLDERS.document,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': FOLDERS.document,
  'application/vnd.ms-excel': FOLDERS.document,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FOLDERS.document,
  'application/vnd.ms-powerpoint': FOLDERS.document,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': FOLDERS.document,
  'text/': FOLDERS.document,
  // Archives
  'application/zip': FOLDERS.archive,
  'application/x-rar-compressed': FOLDERS.archive,
  'application/x-7z-compressed': FOLDERS.archive,
  'application/x-tar': FOLDERS.archive,
  'application/x-gzip': FOLDERS.archive
};

// Define blocked file types (dangerous ones)
const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',  // .exe, .dll, etc.
  'application/x-ms-dos-executable',
  'application/x-msi',
  'application/x-ms-shortcut',
  'application/x-ms-application',
  'application/x-ms-manifest',
  'application/x-sh',
  'application/x-shockwave-flash',
  'application/x-silverlight-app',
  'application/x-msaccess',
  'application/x-msbinder',
  'application/x-mscardfile',
  'application/x-msclip',
  'application/x-msmediaview',
  'application/x-msmetafile',
  'application/x-msmoney',
  'application/x-mspublisher',
  'application/x-msschedule',
  'application/x-msterminal',
  'application/x-mswrite',
  'application/x-perfmon',
  'application/x-pkcs12',
  'application/x-pkcs7-certificates',
  'application/x-pkcs7-certreqresp',
  'application/x-pkcs7-mime',
  'application/x-pkcs7-signature',
  'application/x-silverlight',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-msdos-windows',
  'application/x-msdos-command'
]);


interface UploadOptions {
  alt?: string;
  title?: string;
  description?: string;
}

interface UploadResult {
  success: boolean;
  id?: string;
  filename?: string;
  url?: string;
  width?: number;
  height?: number;
  size?: number;
  mimeType?: string;
  error?: string;
}

export async function uploadFile(file: File, options: UploadOptions = {}): Promise<UploadResult> {
  try {
    // Block dangerous file types
    if (file.type && BLOCKED_MIME_TYPES.has(file.type)) {
      return { 
        success: false, 
        error: `نوع فایل '${file.type}' به دلایل امنیتی مجاز نمی‌باشد.`
      };
    }
    
    // Preserve original filename for non-Latin characters
    const originalName = file.name || 'file';
    const fileNameParts = originalName.split('.');
    const fileExtension = fileNameParts.length > 1 ? `.${fileNameParts.pop()?.toLowerCase()}` : '';
    
    // Ensure we have a valid MIME type
    let mimeType = file.type || '';
    if (!mimeType && fileExtension) {
      // Try to determine MIME type from extension if not provided
      const extensionToMime: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain',
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.7z': 'application/x-7z-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime'
      };
      mimeType = extensionToMime[fileExtension.toLowerCase()] || 'application/octet-stream';
    }

    // Set appropriate max size based on file type
    const isVideo = mimeType.startsWith('video/');
    const isImage = mimeType.startsWith('image/');
    const maxSize = isVideo ? 50 * 1024 * 1024 : // 50MB for videos
                  isImage ? 10 * 1024 * 1024 :  // 10MB for images
                  5 * 1024 * 1024;             // 5MB for other files
    
    // Validate file size
    if (file.size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(0);
      return { 
        success: false, 
        error: `حجم فایل نباید بیشتر از ${maxSizeMB} مگابایت باشد.` 
      };
    }

    // Determine the appropriate folder based on MIME type
    let folder: string = FOLDERS.other;
    for (const [mimePrefix, folderName] of Object.entries(MIME_TO_FOLDER)) {
      if (mimeType.startsWith(mimePrefix)) {
        folder = folderName;
        break;
      }
    }
    
    // Create the full upload path with the appropriate folder
    const fullUploadDir = join(UPLOAD_DIR, folder);
    await mkdir(fullUploadDir, { recursive: true });

    // Get the base name without extension
    const baseName = originalName.includes('.')
      ? originalName.substring(0, originalName.lastIndexOf('.'))
      : originalName;
      
    // Sanitize the base name
    const sanitizedBaseName = baseName
      .replace(/[^\p{L}\p{N}\s-]/gu, '') // Remove special chars but keep letters, numbers, spaces, and hyphens
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .toLowerCase()
      .substring(0, 100) // Limit length
      || uuidv4(); // Fallback to UUID if empty after sanitization
      
    const fileExt = fileExtension; // Keep the original extension with dot (e.g., '.png')
    
    // Function to generate a safe filename with retry logic
    const generateSafeFilename = async (base: string, ext: string, attempt = 0): Promise<string> => {
      const maxAttempts = 10;
      // Only add the attempt number if it's not the first attempt
      const baseName = attempt === 0 ? base : `${base}-${attempt}`;
      const filename = `${baseName}${ext}`;
      
      try {
        // Check if file exists in database
        const existsInDb = await prisma.media.findUnique({
          where: { filename }
        });
        
        // Check if file exists on disk
        const { existsSync } = await import('fs');
        const existsOnDisk = existsSync(join(UPLOAD_DIR, filename));
        
        if (!existsInDb && !existsOnDisk) {
          return filename; // This filename is available
        }
        
        // If we've reached max attempts, use a UUID
        if (attempt >= maxAttempts) {
          console.warn(`Reached max attempts (${maxAttempts}), using UUID fallback`);
          return `${uuidv4()}${ext}`;
        }
        
        // Try again with incremented counter
        return generateSafeFilename(base, ext, attempt + 1);
        
      } catch (error) {
        console.error('Error checking filename uniqueness:', error);
        // On error, fall back to UUID
        return `${uuidv4()}${ext}`;
      }
    };
    
    // Generate a safe filename with folder path
    const filename = await generateSafeFilename(sanitizedBaseName, fileExt);
    const finalFolder = folder; // Store the determined folder
    
    // The filename already includes the extension from generateSafeFilename
    let finalFilename = filename;
    
    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const buffer = Buffer.from(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
    
    // Handle image and non-image files differently
    let width: number | undefined;
    let height: number | undefined;
    let finalBuffer: Buffer = buffer;
    
    // Only process with sharp if it's an image
    if (mimeType.startsWith('image/')) {
      try {
        const image = sharp(buffer);
        const metadata = await image.metadata();
        width = metadata.width;
        height = metadata.height;
        
        // Only convert to webp if it's not already webp or gif
        if (!['image/webp', 'image/gif'].includes(mimeType)) {
          finalBuffer = await image.webp({ quality: 80 }).toBuffer();
          finalFilename = filename.replace(/\.[^.]+$/, '.webp');
          mimeType = 'image/webp';
        }
      } catch (error) {
        console.warn('Image processing failed, saving original:', error);
        // Continue with original file if image processing fails
      }
    }
    
    // Save the processed file in the appropriate folder
    const finalFilePath = join(finalFolder, finalFilename);
    const fullPath = join(UPLOAD_DIR, finalFilePath);
    
    // Ensure the directory exists
    await mkdir(join(UPLOAD_DIR, finalFolder), { recursive: true });
    
    // Check if file exists before writing
    const { existsSync } = await import('fs');
    if (existsSync(fullPath)) {
      // If file exists, generate a new name
      const newFinalFilename = await generateSafeFilename(sanitizedBaseName, fileExt, 1);
      const newFinalFilePath = join(finalFolder, newFinalFilename);
      const newFullPath = join(UPLOAD_DIR, newFinalFilePath);
      
      await writeFile(newFullPath, finalBuffer);
      console.log(`File saved to: ${newFullPath}`);
      finalFilename = newFinalFilename;
    } else {
      await writeFile(fullPath, finalBuffer);
      console.log(`File saved to: ${fullPath}`);
    }
    
    // Save to database within a transaction
    const media = await prisma.$transaction(async (tx) => {
      // Double-check the filename is still available
      const exists = await tx.media.findUnique({
        where: { filename }
      });
      
      if (exists) {
        // If somehow the file exists, generate a new name and try again
        const newFilename = await generateSafeFilename(sanitizedBaseName, fileExt, 100);
        const newFilePath = join(finalFolder, newFilename);
        return tx.media.create({
          data: {
            filename: newFilePath.replace(/\\/g, '/'),
            url: `/uploads/${newFilePath.replace(/\\/g, '/')}`,
            alt: options.alt || '',
            title: options.title || '',
            description: options.description || '',
            width: width || null,
            height: height || null,
            size: finalBuffer.length,
            mimeType: mimeType,
          },
        });
      }
      
      // If we get here, the filename is available
      return tx.media.create({
        data: {
          filename: finalFilePath.replace(/\\/g, '/'),
          url: `/uploads/${finalFilePath.replace(/\\/g, '/')}`,
          alt: options.alt || '',
          title: options.title || '',
          description: options.description || '',
          width: width || null,
          height: height || null,
          size: finalBuffer.length,
          mimeType: mimeType,
        },
      });
    });
    
    return { 
      success: true, 
      id: media.id,
      filename: finalFilePath.replace(/\\/g, '/'),
      url: media.url,
      width: media.width || undefined,
      height: media.height || undefined,
      size: media.size,
      mimeType: media.mimeType
    };
  } catch (error) {
    console.error('Error uploading file:', error);
    return { 
      success: false, 
      error: 'خطا در آپلود فایل. لطفاً دوباره تلاش کنید.' 
    };
  }
}

export async function deleteFile(filename: string): Promise<{ success: boolean; error?: string }> {
  try {
    await prisma.$transaction([
      // Delete from database
      prisma.media.deleteMany({
        where: { filename },
      }),
    ]);

    // Delete the file
    const filePath = join(UPLOAD_DIR, filename);
    await unlink(filePath);
    
    // Also delete webp version if it exists
    const webpPath = filePath.replace(/\.(jpg|jpeg|png)$/i, '.webp');
    if (webpPath !== filePath) {
      await unlink(webpPath).catch(() => {}); // Ignore if webp version doesn't exist
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'خطا در حذف فایل' 
    };
  }
}

export async function getMediaById(id: string) {
  return prisma.media.findUnique({
    where: { id },
  });
}

export async function listMedia({
  page = 1,
  limit = 20,
  search = '',
}: {
  page?: number;
  limit?: number;
  search?: string;
} = {}) {
  const skip = (page - 1) * limit;
  
  const where = search
    ? {
        OR: [
          { filename: { contains: search, mode: 'insensitive' as const } },
          { alt: { contains: search, mode: 'insensitive' as const } },
          { title: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [items, total] = await Promise.all([
    prisma.media.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.media.count({ where }),
  ]);

  return {
    items,
    pagination: {
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    },
  };
}
