import { CoreMessage } from '@shared/types.ts';
import { SupabaseClient } from './supabaseClient.ts';
import { ContentBlockParam } from 'npm:@anthropic-ai/sdk/resources/messages';
import { detectImageMediaType } from './imageMime.ts';

/**
 * Reformats a Supabase signed URL to use the correct host (local ngrok or production)
 * This is needed because signed URLs use the internal Supabase URL, but we need the external host
 */
export function reformatSignedUrl(signedUrl: string): string {
  const supabaseHost =
    (Deno.env.get('ENVIRONMENT') === 'local'
      ? Deno.env.get('NGROK_URL')
      : Deno.env.get('SUPABASE_URL')
    )?.trim() ?? '';

  const url = new URL(signedUrl);
  return `${supabaseHost}${url.pathname}${url.search}`;
}

export async function getSignedUrl(
  supabaseClient: SupabaseClient,
  bucket: string,
  path: string,
): Promise<string | null> {
  const { data: rawImageUrl } = await supabaseClient.storage
    .from(bucket)
    .createSignedUrl(path, 60 * 60);

  if (!rawImageUrl?.signedUrl) {
    return null;
  }

  return reformatSignedUrl(rawImageUrl.signedUrl);
}

export async function getSignedUrls(
  supabaseClient: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<string[]> {
  const { data: signedUrls } = await supabaseClient.storage
    .from(bucket)
    .createSignedUrls(paths, 60 * 60);

  return signedUrls
    ? signedUrls
        .filter((image) => !image.error && image.signedUrl)
        .map((image) => reformatSignedUrl(image.signedUrl))
    : [];
}

/**
 * Downloads images from Supabase Storage and converts them to base64 data URLs
 * This is needed for OpenRouter/OpenAI API which may not be able to fetch remote URLs
 */
export async function getBase64Images(
  supabaseClient: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<Array<{ data: string; mediaType: string }>> {
  const images = await Promise.all(
    paths.map(async (path) => {
      try {
        const { data, error } = await supabaseClient.storage
          .from(bucket)
          .download(path);

        if (error || !data) {
          console.error(`Failed to download image ${path}:`, error);
          return null;
        }

        // Convert Blob to ArrayBuffer to Uint8Array
        const arrayBuffer = await data.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // Convert to base64 using chunked approach (avoids stack overflow on large images)
        let binary = '';
        const chunkSize = 0x8000; // 32KB chunks
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.subarray(
            i,
            Math.min(i + chunkSize, uint8Array.length),
          );
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        const base64 = btoa(binary);

        const mediaType = detectImageMediaType(uint8Array, data.type);

        return {
          data: `data:${mediaType};base64,${base64}`,
          mediaType,
        };
      } catch (err) {
        console.error(`Error processing image ${path}:`, err);
        return null;
      }
    }),
  );

  return images.filter(
    (img): img is { data: string; mediaType: string } => img !== null,
  );
}

// Format user message blocks (supports text, error context and signed image URLs)
export async function formatUserMessage(
  message: CoreMessage,
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<{
  role: 'user';
  content: ContentBlockParam[];
}> {
  const parts: ContentBlockParam[] = [];

  if (message.content.text) {
    parts.push({ type: 'text', text: message.content.text });
  }

  if (message.content.error) {
    parts.push({
      type: 'text',
      text: `The OpenSCAD code generated has failed to compile and has given the following error, fix any syntax, logic, parameter, library, or other issues: ${message.content.error}`,
    });
  }

  if (message.content.images?.length) {
    const imageFiles = message.content.images.map(
      (imageId) => `${userId}/${conversationId}/${imageId}`,
    );
    const base64Images = await getBase64Images(
      supabaseClient,
      'images',
      imageFiles,
    );

    if (base64Images.length > 0) {
      parts.push({
        type: 'text',
        text: `Reference images (IDs: ${message.content.images.join(', ')}):`,
      });
      parts.push(
        ...base64Images.map((image) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: image.mediaType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: image.data.split(',')[1],
          },
        })),
      );
    } else {
      parts.push({
        type: 'text',
        text: `User uploaded ${message.content.images.length} reference image(s) with IDs: ${message.content.images.join(', ')}`,
      });
    }
  }

  // Handle mesh uploads with parametric enrichments (bounding box + render images)
  if (message.content.mesh && message.content.meshBoundingBox) {
    const bbox = message.content.meshBoundingBox;
    const filename = message.content.meshFilename || 'model.stl';

    const modelHeight = bbox.y;
    const modelWidth = bbox.x;
    const modelDepth = bbox.z;

    const instruction = `User uploaded a 3D model (STL file): "${filename}"

**MODEL DIMENSIONS (CRITICAL FOR POSITIONING):**
- Width (X): ${modelWidth.toFixed(1)}mm
- Height (Z after rotation): ${modelHeight.toFixed(1)}mm
- Depth (Y after rotation): ${modelDepth.toFixed(1)}mm

The model is CENTERED at origin. After rotation:
- TOP of model is at Z = +${(modelHeight / 2).toFixed(1)}mm
- BOTTOM of model is at Z = -${(modelHeight / 2).toFixed(1)}mm

YOU MUST USE import("${filename}") TO INCLUDE THE USER'S MODEL.

**POSITIONING OBJECTS (CRITICAL):**
- To place something ON TOP (like a hat): translate to Z = ${(modelHeight / 2).toFixed(1)} or higher
- To place something BELOW (like a stand): translate to Z = -${(modelHeight / 2).toFixed(1)} or lower
- Objects should NOT intersect the model unless cutting with difference()

**ORIENTATION:**
Use rotation_x = 90 to stand the model upright (matching the render images).

EXAMPLE - Adding a hat on top:
rotation_x = 90;
rotation_y = 0;
rotation_z = 0;
hat_pos_z = ${(modelHeight / 2 + 5).toFixed(0)}; // Above model top
$fn = 64;

union() {
    rotate([rotation_x, rotation_y, rotation_z])
        import("${filename}");
    translate([0, 0, hat_pos_z])
        cylinder(h=10, d1=20, d2=5); // Hat above the model
}

The render images show the model from: isometric, top, front, right views.`;

    parts.push({
      type: 'text',
      text: instruction,
    });
  } else if (message.content.mesh) {
    // Mesh without bounding box — simple preview (like creative mode)
    const previewSignedUrl = await getSignedUrl(
      supabaseClient,
      'images',
      `${userId}/${conversationId}/preview-${message.content.mesh.id}`,
    );

    if (previewSignedUrl) {
      parts.push({
        type: 'text',
        text: `User uploaded a 3D mesh file (ID: ${message.content.mesh.id}, type: ${message.content.mesh.fileType})`,
      });
      const base64Preview = await getBase64Images(supabaseClient, 'images', [
        `${userId}/${conversationId}/preview-${message.content.mesh.id}`,
      ]);
      if (base64Preview.length > 0) {
        parts.push(
          ...base64Preview.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType as
                | 'image/jpeg'
                | 'image/png'
                | 'image/gif'
                | 'image/webp',
              data: image.data.split(',')[1],
            },
          })),
        );
      }
    } else {
      parts.push({
        type: 'text',
        text: `User uploaded a 3D mesh file (ID: ${message.content.mesh.id}, type: ${message.content.mesh.fileType})`,
      });
    }
  }

  return { role: 'user', content: parts };
}

export async function formatCreativeUserMessage(
  message: CoreMessage,
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<{
  role: 'user';
  content: ContentBlockParam[];
}> {
  const parts: ContentBlockParam[] = [];

  if (message.content.text) {
    parts.push({
      type: 'text',
      text: message.content.text,
    });
  }

  // Add images if they exist (inline base64 — works locally without ngrok
  // and avoids an extra HTTPS roundtrip from Anthropic to our storage in prod)
  if (message.content.images?.length) {
    const imageFiles = message.content.images.map(
      (imageId) => `${userId}/${conversationId}/${imageId}`,
    );

    const base64Images = await getBase64Images(
      supabaseClient,
      'images',
      imageFiles,
    );

    if (base64Images.length > 0) {
      parts.push({
        type: 'text',
        text: `Here are the image(s) with the following ID(s) respectively: ${message.content.images.join(', ')}`,
      });
      parts.push(
        ...base64Images.map((image) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: image.mediaType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: image.data.split(',')[1],
          },
        })),
      );
    } else {
      parts.push({
        type: 'text',
        text: `User uploaded image(s) with the ID(s) ${message.content.images.join(', ')}`,
      });
    }
  }

  // Add multiview slot images inline so the model sees each labeled view
  // (front/left/back/right) and knows to invoke create_mesh with them.
  const multiviewImages = message.content.multiviewImages;
  if (multiviewImages && Object.values(multiviewImages).some((v) => !!v)) {
    const slotOrder: Array<'front' | 'left' | 'back' | 'right'> = [
      'front',
      'left',
      'back',
      'right',
    ];
    const populatedSlots = slotOrder.filter((slot) => !!multiviewImages[slot]);
    const slotIds = populatedSlots.map(
      (slot) => multiviewImages[slot] as string,
    );
    const slotPaths = slotIds.map(
      (imageId) => `${userId}/${conversationId}/${imageId}`,
    );

    const base64SlotImages = await getBase64Images(
      supabaseClient,
      'images',
      slotPaths,
    );

    parts.push({
      type: 'text',
      text: `The user provided a multiview set. Call create_mesh with model=multiview using these labeled views (${populatedSlots.join(', ')}). Image IDs in order: ${slotIds.join(', ')}.`,
    });

    if (base64SlotImages.length === populatedSlots.length) {
      populatedSlots.forEach((slot, idx) => {
        const img = base64SlotImages[idx];
        parts.push({
          type: 'text',
          text: `${slot} view (id ${slotIds[idx]}):`,
        });
        parts.push({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: img.data.split(',')[1],
          },
        });
      });
    }
  }

  // Add mesh preview if it exists (inline base64, same reasoning as above)
  if (message.content.mesh) {
    const base64Preview = await getBase64Images(supabaseClient, 'images', [
      `${userId}/${conversationId}/preview-${message.content.mesh.id}`,
    ]);

    if (base64Preview.length > 0) {
      parts.push({
        type: 'text',
        text: `Here is a preview of the mesh with the ID ${message.content.mesh.id}`,
      });
      parts.push(
        ...base64Preview.map((image) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: image.mediaType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: image.data.split(',')[1],
          },
        })),
      );
    } else {
      parts.push({
        type: 'text',
        text: `User uploaded mesh with the ID ${message.content.mesh.id}`,
      });
    }
  }

  return {
    role: 'user',
    content: parts,
  };
}
