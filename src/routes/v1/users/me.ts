import { OAuth_App, Prisma, UserEmailChange } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { generateSecret, verifyToken } from 'node-2fa';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { authorize } from '../../../middlewares/auth';
import { AVAILABLE_LANGUAGES_REGEX } from '../../../utils/CONSTS';
import createError from '../../../utils/createError';
import createResponse from '../../../utils/createResponse';
import { randomString } from '../../../utils/crypto';
import { removeProps } from '../../../utils/masker';
import { multerUploadSingle } from '../../../utils/multipart';
import prisma, { getUniqueKey, maskUserMe, maskUserOAuth } from '../../../utils/prisma';
import { validate } from '../../../utils/schema';

const router = Router();

router.get(
    '/me',
    authorize({
        requiredScopes: ['account.read.basic'],
    }),
    async (req: Request, res: Response) => {
        const user = { avatar: `${process.env.NAPI_URL}/v1/users/${req.user.id}/avatar.webp`, ...req.user };

        if (req.oauth) return createResponse(res, 200, maskUserOAuth(user, req.oauth));
        else createResponse(res, 200, maskUserMe(user));
    }
);

router.post('/emailReset', authorize({ disableBearer: true, requireMfa: false }), validate(z.object({ newEmail: z.string() })), async (req: Request, res: Response) => {
    const { newEmail } = req.body;

    const emailUser = await prisma.user.findFirst({ where: { email: newEmail } });

    if (emailUser)
        return createError(res, 400, {
            message: 'This email is already taken',
            code: 'taken_email',
            type: 'validation',
        });

    const data = await prisma.userEmailChange.create({
        data: {
            newEmail: newEmail,
            userId: req.user.id,
            expiresAt: new Date(Date.now() + 86400000),
            codeNewMail: await getUniqueKey(prisma.userEmailChange, 'codeNewMail', randomString),
            codeOldMail: await getUniqueKey(prisma.userEmailChange, 'codeOldMail', randomString),
        },
    });

    createResponse(res, 200, { success: true });

    const transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: 465,
        tls: {
            rejectUnauthorized: false,
        },
        auth: {
            user: process.env.MAIL_USERNAME,
            pass: process.env.PASSWORD,
        },
    });

    await transporter.sendMail({
        from: process.env.MAIL_USERNAME,
        to: req.user.email,
        subject: 'Confirm requested e-mail address change',
        html: `<center><img src="https://f.nove.team/emailReset.svg" width="380" height="126" alt="Confirm requested e-mail address change"><div style="margin:10px 0;padding:20px;max-width:380px;width:calc(100% - 20px * 2);background:#ededed;border-radius:25px;font-family:sans-serif;user-select:none;text-align:left"><p style="font-size:17px;line-height:1.5;margin:0;margin-bottom:10px;text-align:left">Hello,&nbsp;<b>${req.user.username}</b>. Someone requested to change your Nove account e-mail. In order to approve that request click "Confirm e-mail change" button. If that wasn't you, just ignore this message.</p><a style="display:block;width:fit-content;border-radius:50px;padding:5px 9px;font-size:16px;color:#fff;background:#000;text-decoration:none;text-align:left" href="${process.env.NAPI_URL}/v1/users/confirmEmailChange?code=${data.codeOldMail}">Confirm e-mail change</a></div><p style="max-width:380px;width:380px;text-align:left;font-size:14px;opacity:.7;font-family:sans-serif;user-select:none">We create FOSS privacy-respecting software for everyday use.<a href="${process.env.FRONTEND_URL}" target="_blank">Website</a>,<a href="${process.env.FRONTEND_URL}/privacy" target="_blank">Privacy Policy</a></p></center>`,
    });

    await transporter
        .sendMail({
            from: process.env.MAIL_USERNAME,
            to: newEmail,
            subject: 'Confirm requested e-mail address change',
            html: `<center><img src="https://f.nove.team/emailReset.svg" width="380" height="126" alt="Confirm requested e-mail address change"><div style="margin:10px 0;padding:20px;max-width:380px;width:calc(100% - 20px * 2);background:#ededed;border-radius:25px;font-family:sans-serif;user-select:none;text-align:left"><p style="font-size:17px;line-height:1.5;margin:0;margin-bottom:10px;text-align:left">Hello,&nbsp;<b>${req.user.username}</b>. Someone requested to change your Nove account e-mail. In order to approve that request click "Confirm e-mail change" button. If that wasn't you, just ignore this message.</p><a style="display:block;width:fit-content;border-radius:50px;padding:5px 9px;font-size:16px;color:#fff;background:#000;text-decoration:none;text-align:left" href="${process.env.NAPI_URL}/v1/users/confirmEmailChange?code=${data.codeNewMail}">Confirm e-mail change</a></div><p style="max-width:380px;width:380px;text-align:left;font-size:14px;opacity:.7;font-family:sans-serif;user-select:none">We create FOSS privacy-respecting software for everyday use.<a href="${process.env.FRONTEND_URL}" target="_blank">Website</a>,<a href="${process.env.FRONTEND_URL}/privacy" target="_blank">Privacy Policy</a></p></center>`,
        })
        .then(console.log);
});

router.get('/confirmEmailChange', authorize({ disableBearer: true, requireMfa: false }), async (req: Request, res: Response) => {
    const code = req.query.code as string;

    const newEmailObject = await prisma.userEmailChange.findFirst({
        where: {
            OR: [{ codeNewMail: code }, { codeOldMail: code }],
        },
    });

    if (!newEmailObject)
        return createError(res, 404, {
            code: 'invalid_code',
            message: 'invalid email change code',
            param: 'query:code',
            type: 'authorization',
        });

    if (code === newEmailObject.codeNewMail)
        await prisma.userEmailChange.update({
            where: { id: newEmailObject.id },
            data: { codeNewMail: '' },
        });
    if (code === newEmailObject.codeOldMail)
        await prisma.userEmailChange.update({
            where: { id: newEmailObject.id },
            data: { codeOldMail: '' },
        });

    const newData = (await prisma.userEmailChange.findFirst({ where: { id: newEmailObject.id } })) as UserEmailChange;

    if (!newData.codeNewMail.length && !newData.codeOldMail.length) {
        await prisma.userEmailChange.delete({
            where: { id: newEmailObject.id },
        });

        await prisma.user.update({ where: { id: req.user.id }, data: { email: newEmailObject.newEmail } });

        return createResponse(res, 200, { success: true });
    }

    return createResponse(res, 200, { text: `you have to verify your ${code === newEmailObject.codeNewMail ? 'old' : 'new'} also` });
});

router.patch(
    '/me',
    validate(
        z.object({
            username: z
                .string()
                .min(3)
                .max(24)
                .regex(/[a-zA-Z0-9._-]{3,24}$/g)
                .optional(),
            bio: z.string().min(1).max(256).optional(),
            language: z.string().regex(AVAILABLE_LANGUAGES_REGEX).optional(),
            trackActivity: z.boolean().optional(),
        }),
        'body'
    ),
    authorize({
        requiredScopes: ['account.write.basic'],
        // TODO: Add scopes for each field
        // TODO: Remove this line and actually implement patching user data by OAuth apps
        disableBearer: true,
    }),
    async (req: Request, res: Response) => {
        let data: Prisma.XOR<Prisma.UserUpdateInput, Prisma.UserUncheckedUpdateInput> = {};

        if (req.body.bio?.length) data['bio'] = req.body.bio;
        if (req.body.username?.length) {
            const user = await prisma.user.findFirst({ where: { username: req.body.username } });

            if (user) return createError(res, 400, { message: 'This username is already taken', code: 'taken_username', type: 'validation' });

            data['username'] = req.body.username;
        }
        if (req.body.language?.length) data['language'] = req.body.language;
        if (typeof req.body.trackActivity === 'boolean') {
            data['trackActivity'] = req.body.trackActivity;

            await prisma.trackedDevices.deleteMany({ where: { userId: req.user.id } });
        }

        const newUser = await prisma.user.update({
            where: { id: req.user.id },
            data,
        });

        return createResponse(res, 200, maskUserMe(newUser));
    }
);

router.patch(
    '/me/mfa',
    validate(
        z.object({
            enabled: z.boolean().optional(),
        }),
        'body'
    ),
    authorize({
        disableBearer: true,
    }),
    async (req: Request, res: Response) => {
        if (req.user.mfaEnabled) {
            if (!req.body.enabled) return createError(res, 400, { message: 'mfa is already disabled', code: 'mfa_already_disabled', type: 'validation' });

            const mfa = req.headers['x-mfa'] as string;

            if (/[a-zA-Z0-9]{16}/.test(mfa)) {
                await prisma.user.update({
                    where: { id: req.user.id },
                    data: {
                        mfaEnabled: false,
                        mfaSecret: '',
                        mfaRecoveryCodes: [] as string[],
                    },
                });

                return createResponse(res, 200, { message: 'mfa disabled' });
            }

            if (!mfa || !/[0-9]{6}/.test(mfa))
                return createError(res, 403, {
                    code: 'mfa_required',
                    message: 'mfa required',
                    param: 'header:x-mfa',
                    type: 'authorization',
                });
            if (verifyToken(req.user.mfaSecret, mfa)?.delta !== 0)
                return createError(res, 403, {
                    code: 'invalid_mfa_token',
                    message: 'invalid mfa token',
                    param: 'header:x-mfa',
                    type: 'authorization',
                });

            await prisma.user.update({
                where: { id: req.user.id },
                data: {
                    mfaEnabled: req.body.enabled,
                    mfaSecret: '',
                    mfaRecoveryCodes: [] as string[],
                },
            });

            return createResponse(res, 200, { message: 'mfa disabled' });
        } else {
            if (req.body.enabled) return createError(res, 400, { message: 'mfa is already enabled', code: 'mfa_already_enabled', type: 'validation' });
            const newSecret = generateSecret({ name: 'Nove Account', account: req.user.username });
            const newCodes = Array.from({ length: 10 }, () => randomString(16));

            await prisma.user.update({
                where: { id: req.user.id },
                data: {
                    mfaEnabled: req.body.enabled,
                    mfaSecret: newSecret.secret,
                    mfaRecoveryCodes: newCodes,
                },
            });

            return createResponse(res, 200, { secret: newSecret, codes: newCodes });
        }
    }
);

router.get(
    '/me/mfa/securityCodes',
    authorize({
        disableBearer: true,
        requireMfa: true,
    }),
    async (req: Request, res: Response) => {
        createResponse(res, 200, req.user.mfaRecoveryCodes);
    }
);

router.get('/me/activity', authorize({ disableBearer: true }), async (req: Request, res: Response) => {
    if (!(await prisma.user.findFirst({ where: { id: req.user.id } }))?.trackActivity)
        return createError(res, 400, {
            code: 'activity_disabled',
            message: 'Account activity is turned off',
            type: 'request',
        });

    let perPage = Math.abs(parseInt(req.query.perPage as string)) || 10;

    if (perPage > 25 || perPage < 1) perPage = 3;

    const devices = await prisma.trackedDevices.findMany({
        where: {
            userId: req.user.id,
        },
        skip: req.query.page ? parseInt(req.query.page.toString()) * perPage : 0,
        take: perPage,
        orderBy: {
            updatedAt: 'desc',
        },
    });

    createResponse(res, 200, devices);
});

router.patch(
    '/avatar',
    authorize({
        requiredScopes: ['account.write.avatar'],
    }),
    multerUploadSingle(),
    validate(z.object({ file: z.any() })),
    async (req: Request, res: Response) => {
        const file = req.file as Express.Multer.File;

        if (!file)
            return createError(res, 400, {
                code: 'invalid_parameter',
                message: 'You have to send an image',
                param: 'body:avatar',
                type: 'validation',
            });

        const newUser = await prisma.user.update({ where: { id: req.user.id }, data: { updatedAt: new Date() } });

        return createResponse(res, 200, maskUserMe(newUser));
    }
);

router.get('/me/connections', authorize({ disableBearer: true }), async (req: Request, res: Response) => {
    const oauth2 = await prisma.oAuth_Authorization.findMany({ where: { user_id: req.user.id }, include: { app: true } });
    const apps: OAuth_App[] = [];

    createResponse(
        res,
        200,
        oauth2.map((x) => removeProps(x, ['token', 'refresh_token', 'app.client_secret']))
    );
});

export default router;
