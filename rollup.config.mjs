import { readFileSync } from 'fs';

import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import copy from 'rollup-plugin-copy';
import scss from 'rollup-plugin-scss';
import sass from 'sass';

function htmlPlugin() {
    return {
        name: 'html',
        buildStart() {
            this.addWatchFile('src/index.html');
        },
        generateBundle() {
            const contents = readFileSync('src/index.html', 'utf-8');
            const transformed = contents.replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`);
            this.emitFile({
                type: 'asset',
                fileName: 'index.html',
                source: transformed
            });
        }
    };
}

const buildCss = {
    input: 'src/index.scss',
    output: {
        dir: 'dist'
    },
    plugins: [
        scss({
            exclude: ['static/**/*'],
            fileName: 'index.css',
            sourceMap: true,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                .process(css, { from: undefined })
                .then(result => result.css);
            }
        }),
        {
            name: 'suppress-empty-chunks',
            generateBundle(options, bundle) {
                for (const [fileName, chunk] of Object.entries(bundle)) {
                    if (chunk.type === 'chunk' && chunk.code.trim() === '') {
                        delete bundle[fileName];
                    }
                }
            }
        }
    ]
};

const buildPublic = {
    input: 'src/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        typescript(),
        json(),
        htmlPlugin(),
        copy({
            targets: [
                { src: 'static', dest: 'dist' },
                { src: 'logo.png', dest: 'dist' }
            ]
        })
    ]
};

export default [buildCss, buildPublic];
