import { uploadFile } from '../../../../../lib/media-utils';
import { verifyToken } from '../../../../../lib/auth';
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import Busboy from 'busboy';
import stream from 'stream';
import { NextRequest, NextResponse } from 'next/server';

// Upload directory for temporary files
const UPLOAD_DIR = path.join(process.cwd(), 'public', 'temp');

// Disable body parsing since we're using formidable
export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 300, // 5 minutes
};

// Helper function to generate URL slug from title
const generateSlug = (title: string): string => {
  return title
    .trim()
    .replace(/[^\u0600-\u06FF\uFB8A\u067E\u0686\u06AFa-zA-Z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/-+/g, '_') // Replace hyphens with underscores
    .toLowerCase();
};

// Helper function to generate filename from title and original filename
const generateFilename = (title: string, originalFilename: string | { filename: string }): string => {
  // Handle both string and object cases for originalFilename
  const filenameStr = typeof originalFilename === 'string' ? originalFilename : originalFilename.filename;
  const extension = filenameStr.split('.').pop() || '';
  const slug = generateSlug(title);
  return `${slug}.${extension}`;
};

// Helper to parse form data with busboy
const parseForm = (req: NextRequest): Promise<{ fields: { [key: string]: string[] }; files: { [key: string]: { filename: string; mimeType: string; data: Buffer }[] } }> => {
  return new Promise<{ fields: { [key: string]: string[] }; files: { [key: string]: { filename: string; mimeType: string; data: Buffer }[] } }>((resolve, reject) => {
    const fields: { [key: string]: string[] } = {};
    const files: { [key: string]: { filename: string; mimeType: string; data: Buffer }[] } = {};

    try {
      // Convert Web Request body to Node.js stream
      const readable = new stream.Readable();
      readable._read = () => {};
      
      // Get the raw body as a buffer
      req.arrayBuffer().then(body => {
        const buffer = Buffer.from(body);
        
        // Create a readable stream from the buffer
        readable.push(buffer);
        readable.push(null);

        const busboy = Busboy({
          headers: Object.fromEntries(req.headers.entries()),
          limits: {
            fileSize: 10 * 1024 * 1024, // 10MB
            files: 1, // Only allow one file
          }
        });

        // Handle file uploads
        busboy.on('file', (fieldname: string, file: NodeJS.ReadableStream, filename: string, encoding: string, mimetype: string) => {
          const chunks: Buffer[] = [];
          
          file.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          file.on('end', () => {
            const buffer = Buffer.concat(chunks);
            
            // Keep original filename (we'll process it later based on title)
            const decodedFilename = filename;
            
            // Validate file type
            const allowedMimeTypes = [
              'image/jpeg',
              'image/png',
              'image/webp',
              'application/pdf',
              'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.ms-powerpoint',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'text/plain',
              'text/csv',
            ];

            if (mimetype && !allowedMimeTypes.includes(mimetype)) {
              reject(new Error(`Invalid file type: ${mimetype}`));
              return;
            }

            if (!files[fieldname]) {
              files[fieldname] = [];
            }
            
            files[fieldname].push({
              filename: decodedFilename,
              mimeType: mimetype,
              data: buffer
            });
          });
        });

        // Handle form fields
        busboy.on('field', (fieldname: string, val: string) => {
          if (!fields[fieldname]) {
            fields[fieldname] = [];
          }
          fields[fieldname].push(val);
        });

        // Handle finish and errors
        busboy.on('finish', () => {
          resolve({ fields, files });
        });

        busboy.on('error', (err: Error) => {
          reject(err);
        });

        // Pipe readable stream to busboy
        readable.pipe(busboy);
      }).catch(error => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
};

// Schema for request validation
const uploadSchema = z.object({
  alt: z.string().max(255, 'متن جایگزین نباید بیشتر از ۲۵۵ کاراکتر باشد').optional(),
  title: z.string().max(255, 'عنوان نباید بیشتر از ۲۵۵ کاراکتر باشد'),
  description: z.string().max(1000, 'توضیحات نباید بیشتر از ۱۰۰۰ کاراکتر باشد').optional(),
});

// Helper to extract token from request
function getTokenFromRequest(request: Request): string | null {
  // Check for token in Authorization header first
  const authHeader = request.headers.get('authorization');
  
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  
  // Check for token in cookies
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c: string) => {
        const [key, ...rest] = c.trim().split('=');
        return [key, rest.join('=')];
      })
    );
    return cookies['auth-token'] || cookies['adminToken'] || null;
  }
  
  return null;
}

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const token = getTokenFromRequest(request);
    if (!token) {
      return NextResponse.json(
        { success: false, message: 'توکن احراز هویت یافت نشد' },
        { status: 401 }
      );
    }

    const decoded = verifyToken(token);
    if (!decoded?.adminId) {
      return NextResponse.json(
        { success: false, message: 'توکن نامعتبر است' },
        { status: 401 }
      );
    }

    // Ensure upload directory exists
    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    try {
      console.log('=== STARTING FILE UPLOAD ===');
      
      // Parse the form data using busboy
      const { fields, files } = await parseForm(request);
      
      // Get the uploaded file
      const fileArray = files.file;
      if (!fileArray || fileArray.length === 0) {
        return NextResponse.json(
          { success: false, message: 'فایلی در درخواست یافت نشد' },
          { status: 400 }
        );
      }
      
      const uploadedFile = Array.isArray(fileArray) ? fileArray[0] : fileArray;
      
      console.log('Uploaded file info:', {
        originalFilename: uploadedFile.filename,
        mimeType: uploadedFile.mimeType,
        size: uploadedFile.data.length
      });
      
      // Get metadata from form fields
      const alt = Array.isArray(fields.alt) ? fields.alt[0] : fields.alt || '';
      const title = Array.isArray(fields.title) ? fields.title[0] : fields.title || '';
      const description = Array.isArray(fields.description) ? fields.description[0] : fields.description || '';
      
      // Validate metadata
      try {
        uploadSchema.parse({ alt, title, description });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return NextResponse.json(
            { 
              success: false, 
              message: 'اطلاعات وارد شده معتبر نیست',
              errors: error.errors 
            },
            { status: 400 }
          );
        }
        throw error;
      }
      
      // Generate URL slug and new filename based on title
      const urlSlug = generateSlug(title);
      const newFilename = generateFilename(title, uploadedFile.filename);
      
      console.log('Generated metadata:', {
        urlSlug,
        newFilename
      });
      
      // Create a File object for the uploadFile function with the new filename
      const file = new File(
        [uploadedFile.data],
        newFilename,
        { type: uploadedFile.mimeType }
      );
      
      // Upload the file using your existing function
      // The title will be used to generate the URL in the uploadFile function
      const result = await uploadFile(file, {
        alt,
        title: title || newFilename, // Use the title or fallback to filename
        description: description || undefined
      });
      
      if (!result.success) {
        return NextResponse.json(
          { success: false, message: result.error || 'خطا در آپلود فایل' },
          { status: 400 }
        );
      }
      
      return NextResponse.json({
        success: true,
        data: {
          ...result,
          url: urlSlug,
          filename: newFilename
        }
      });
      
    } catch (error) {
      console.error('Error processing file upload:', error);
      
      return NextResponse.json(
        { 
          success: false, 
          message: 'خطا در پردازش فایل',
          error: error instanceof Error ? error.message : 'خطای ناشناخته'
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'خطا در پردازش درخواست آپلود',
        error: error instanceof Error ? error.message : 'خطای ناشناخته'
      },
      { status: 500 }
    );
  }
}