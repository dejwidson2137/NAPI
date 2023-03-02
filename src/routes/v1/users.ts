import { compareSync } from 'bcrypt';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { authorizeBearer, authorizeOwner } from '../../middlewares/auth';
import createError from '../../utils/createError';
import createResponse from '../../utils/createResponse';
import { removeProps } from '../../utils/masker';
import { checkPermissions } from '../../utils/permissions';
import prisma from '../../utils/prisma';
import { validate } from '../../utils/schema';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { multerUploadSingle } from '../../utils/multipart';
import { existsSync } from 'fs';
import { STORAGE_PATH } from '../../utils/CONSTS';
import { join } from 'path';

const router = Router();

router.get('/login', (req: Request, res: Response) => {
    res.render('v1/users/login', {
        redirect: req.query.redirectBack || '__CLOSE__',
    });
});

router.post(
    '/login',
    validate(
        z.object({
            username: z.string().min(1).max(64),
            password: z.string().min(1).max(64),
        })
    ),
    async (req: Request, res: Response) => {
        const user = await prisma.user.findFirst({
            where: {
                OR: [{ username: req.body.username }, { email: req.body.username }],
            },
        });
        if (!user)
            return createError(res, 404, {
                code: 'user_not_found',
                message: 'user with this username was not found',
                param: 'body:username',
                type: 'authorization',
            });
        if (!compareSync(req.body.password, user.password))
            return createError(res, 401, { code: 'invalid_password', message: 'invalid password', param: 'body:password', type: 'authorization' });
        createResponse(res, 200, removeProps(user, ['password']));
    }
);

router.get('/me', authorizeBearer(['account.basic']), async (req: Request, res: Response) => {
    if (checkPermissions(req.oauth.scopes, ['account.email'])) createResponse(res, 200, removeProps(req.user, ['password']));
    else createResponse(res, 200, removeProps(req.user, ['password', 'email']));
});

router.get('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;

    const user = await prisma.user.findFirst({
        where: { id },
    });

    if (!user) return createError(res, 400, { code: 'invalid_id', message: 'This user does not exist!', type: 'validation', param: 'param:id' });

    return createResponse(res, 200, removeProps(user, ['password', 'token', 'email']));
});

router.patch('/password', authorizeOwner, async (req: Request, res: Response) => {
    const { oldPassword, newPassword } = req.body;

    if (!(await bcrypt.compare(oldPassword, req.user.password))) {
        return createError(res, 401, { code: 'invalid_password', message: 'invalid password', param: 'body:password', type: 'authorization' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, bcrypt.genSaltSync());

    await prisma.user.update({
        where: { id: req.user.id },
        data: {
            password: hashedPassword,
        },
    });

    return createResponse(res, 200, removeProps(req.user, ['password', 'token']));
});

router.patch('/email', authorizeOwner, async (req: Request, res: Response) => {
    const { email } = req.body;

    await prisma.user.update({
        where: { id: req.user.id },
        data: {
            email,
        },
    });

    return createResponse(res, 200, removeProps(req.user, ['password', 'token']));
});

router.patch(
    '/me',
    validate(z.object({ username: z.string().min(1).max(24).optional(), bio: z.string().min(1).max(256).optional(), language: z.string().optional() }), 'body'),
    authorizeOwner,
    async (req: Request, res: Response) => {
        let data: Prisma.XOR<Prisma.UserUpdateInput, Prisma.UserUncheckedUpdateInput> = {};

        if (req.body.bio?.length) data['bio'] = req.body.bio;
        if (req.body.username?.length) data['username'] = req.body.username;
        if (req.body.language?.length) {
            //TODO: available languages
            if (!['pl', 'en'].includes(req.body.language))
                return createError(res, 400, {
                    code: 'invalid_parameter',
                    message: 'This page does not support this language',
                    param: 'body:language',
                    type: 'validation',
                });
            data['language'] = req.body.language;
        }

        await prisma.user.update({
            where: { id: req.user.id },
            data,
        });

        return createResponse(res, 200, removeProps(req.user, ['password', 'token']));
    }
);

router.patch('/avatar', authorizeOwner, multerUploadSingle(), validate(z.object({ file: z.any() })), async (req: Request, res: Response) => {
    const file = req.file as Express.Multer.File;

    if (!file)
        return createError(res, 400, {
            code: 'invalid_parameter',
            message: 'You have to send an image',
            param: 'body:avatar',
            type: 'validation',
        });

    return createResponse(res, 200, removeProps(req.user, ['password', 'token']));
});

router.get('/:id/avatar.webp', async (req: Request, res: Response) => {
    const { id } = req.params;

    const user = await prisma.user.findFirst({
        where: { id },
    });

    if (!user) return createError(res, 400, { code: 'invalid_id', message: 'This user does not exists!', type: 'validation', param: 'param:id' });

    const path = existsSync(`${STORAGE_PATH}/${id}.webp`) ? `${STORAGE_PATH}/${id}.webp` : `${join(STORAGE_PATH, '..')}/defaults/AVATAR.webp`;

    return res.sendFile(path);
});

export default router;