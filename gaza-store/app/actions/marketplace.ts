'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { favorites, listingReports, listings, professionals, reviews, user, wantedPosts } from '@/lib/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

export type CurrentUser = { id: string; name: string; email: string; phone: string | null; city: string | null }

const phoneInput = z.preprocess(value => typeof value === 'string' ? value.trim().replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))) : value, z.string().regex(/^05[69]\d{7}$/, 'رقم الجوال يجب أن يبدأ بـ 056 أو 059 ويتكون من 10 أرقام'))

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  const [row] = await db.select({ id: user.id, name: user.name, email: user.email, phone: user.phone, city: user.city }).from(user).where(eq(user.id, session.user.id)).limit(1)
  return row ?? null
}

export async function checkPhoneAvailability(phone: string) {
  const normalized = phoneInput.parse(phone)
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.phone, normalized)).limit(1)
  return { available: !existing }
}

export async function completeRegistration(input: { phone: string; city: string }) {
  const userId = await getUserId()
  const data = z.object({ phone: phoneInput, city: z.string().trim().min(2).max(80) }).parse(input)
  const [updated] = await db.update(user).set(data).where(eq(user.id, userId)).returning({ id: user.id })
  if (!updated) throw new Error('User not found')
  revalidatePath('/')
  return updated
}

export async function getMyData() {
  const userId = await getUserId()
  const [myListings, myProfessionals] = await Promise.all([
    db.select().from(listings).where(eq(listings.userId, userId)).orderBy(desc(listings.createdAt)),
    db.select().from(professionals).where(eq(professionals.userId, userId)).orderBy(desc(professionals.createdAt)),
  ])
  return { listings: myListings, professionals: myProfessionals }
}

const listingInput = z.object({
  title: z.string().trim().min(3).max(120),
  price: z.number().int().positive().max(100000000),
  currency: z.enum(['ILS', 'USD']),
  contactPhone: z.preprocess(value => typeof value === 'string' ? value.trim().replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))) : value, z.string().regex(/^05[69]\d{7}$/, 'رقم التواصل يجب أن يبدأ بـ 056 أو 059 ويتكون من 10 أرقام')),
  location: z.string().trim().min(2).max(80),
  category: z.string().trim().min(2).max(80),
  subcategory: z.string().trim().min(2).max(80),
  image: z.string().url().max(2048).nullable().optional(),
  condition: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
})

const professionalInput = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  experience: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  contactPhone: z.preprocess(value => typeof value === 'string' ? value.trim().replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))) : value, z.string().regex(/^05[69]\d{7}$/, 'رقم التواصل يجب أن يبدأ بـ 056 أو 059 ويتكون من 10 أرقام')),
  image: z.string().url().max(2048).nullable().optional(),
  gallery: z.array(z.string().url().max(2048)).max(12).optional(),
})

const reviewInput = z.object({
  listingId: z.number().int().positive().nullable().optional(),
  professionalId: z.number().int().positive().nullable().optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
}).refine(value => Boolean(value.listingId || value.professionalId), { message: 'A review target is required' })

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

async function requireAdmin() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user || !process.env.ADMIN_EMAIL || session.user.email.toLowerCase() !== process.env.ADMIN_EMAIL.toLowerCase()) throw new Error('Forbidden')
  return session.user.id
}

export async function getAdminReports() {
  await requireAdmin()
  return db.select({ report: listingReports, listing: listings, reporter: user.name }).from(listingReports).leftJoin(listings, eq(listingReports.listingId, listings.id)).leftJoin(user, eq(listingReports.userId, user.id)).where(eq(listingReports.status, 'open')).orderBy(desc(listingReports.createdAt))
}

export async function adminDeleteListing(id: number) {
  await requireAdmin()
  await db.delete(listings).where(eq(listings.id, id))
  revalidatePath('/admin')
}

export async function getListingById(id: number) {
  const [row] = await db.select({ listing: listings, sellerName: user.name, sellerPhone: user.phone }).from(listings).leftJoin(user, eq(listings.userId, user.id)).where(eq(listings.id, id)).limit(1)
  return row ?? null
}

export async function getMarketplaceData() {
  const [listingRows, professionalRows, reviewRows] = await Promise.all([
    db.select({ listing: listings, sellerName: user.name, sellerPhone: user.phone }).from(listings).leftJoin(user, eq(listings.userId, user.id)).orderBy(desc(listings.createdAt)),
    db.select().from(professionals).orderBy(desc(professionals.createdAt)),
    db.select().from(reviews).orderBy(desc(reviews.createdAt)),
  ])
  return { listings: listingRows, professionals: professionalRows, reviews: reviewRows }
}

export async function createListing(input: Omit<typeof listings.$inferInsert, 'userId' | 'id' | 'createdAt' | 'expiresAt'>) {
  const userId = await getUserId()
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(listings).where(and(eq(listings.userId, userId), sql`${listings.createdAt} >= current_date`))
  if (count >= 5) throw new Error('يمكنك نشر 5 إعلانات فقط يومياً')
  const data = listingInput.parse(input)
  const [created] = await db.insert(listings).values({ ...data, userId }).returning()
  revalidatePath('/')
  return created
}

export async function toggleFavorite(listingId: number) {
  const userId = await getUserId()
  const existing = await db.select({ listingId: favorites.listingId }).from(favorites).where(and(eq(favorites.userId, userId), eq(favorites.listingId, listingId))).limit(1)
  if (existing.length) await db.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.listingId, listingId)))
  else await db.insert(favorites).values({ userId, listingId })
  revalidatePath('/')
  return { saved: !existing.length }
}

export async function getMyFavorites() {
  const userId = await getUserId()
  return db.select({ listing: listings }).from(favorites).innerJoin(listings, eq(favorites.listingId, listings.id)).where(eq(favorites.userId, userId)).orderBy(desc(favorites.createdAt))
}

export async function reportListing(listingId: number, reason: string) {
  const userId = await getUserId()
  const data = z.object({ listingId: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }).parse({ listingId, reason })
  await db.insert(listingReports).values({ ...data, userId })
  return { success: true }
}

export async function createProfessional(input: Omit<typeof professionals.$inferInsert, 'userId' | 'id' | 'createdAt' | 'rating'>) {
  const userId = await getUserId()
  const data = professionalInput.parse(input)
  const [created] = await db.insert(professionals).values({ ...data, userId }).returning()
  revalidatePath('/')
  return created
}

export async function createReview(input: Omit<typeof reviews.$inferInsert, 'userId' | 'id' | 'createdAt'>) {
  const userId = await getUserId()
  const data = reviewInput.parse(input)
  const [created] = await db.insert(reviews).values({ ...data, userId }).returning()
  revalidatePath('/')
  return created
}

export async function getMyListings() {
  const userId = await getUserId()
  return db.select().from(listings).where(eq(listings.userId, userId)).orderBy(desc(listings.createdAt))
}

export async function renewListing(id: number) {
  const userId = await getUserId()
  const [updated] = await db.update(listings).set({ expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) }).where(and(eq(listings.id, id), eq(listings.userId, userId))).returning()
  if (!updated) throw new Error('Listing not found')
  revalidatePath('/')
  return updated
}

export async function updateListing(id: number, input: Partial<Omit<typeof listings.$inferInsert, 'userId' | 'id' | 'createdAt' | 'expiresAt'>>) {
  const userId = await getUserId()
  const data = listingInput.partial().parse(input)
  const [updated] = await db.update(listings).set(data).where(and(eq(listings.id, id), eq(listings.userId, userId))).returning()
  if (!updated) throw new Error('Listing not found')
  revalidatePath('/')
  return updated
}

export async function deleteListing(id: number) {
  const userId = await getUserId()
  const [deleted] = await db.delete(listings).where(and(eq(listings.id, id), eq(listings.userId, userId))).returning({ id: listings.id })
  if (!deleted) throw new Error('لم يتم العثور على الإعلان أو لا تملك صلاحية حذفه')
  revalidatePath('/')
  return { success: true, id: deleted.id }
}

export async function deleteProfessional(id: number) {
  const userId = await getUserId()
  await db.delete(professionals).where(and(eq(professionals.id, id), eq(professionals.userId, userId)))
  revalidatePath('/')
}
