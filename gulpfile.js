const gulp = require('gulp')
const babel = require('gulp-babel')
const path = require('path')
const nodemon = require('gulp-nodemon')
const chalk = require('chalk')

gulp.task('build', () => {
    return gulp.src(['src/**/*.ts', 'src/**/*.js'])
        .pipe(babel())
        .pipe(gulp.dest('./dist'))
})

gulp.task('watch', gulp.series('build', async (done) => {
    // gulp.watch('./*.js', gulp.series('build'));
    return nodemon({
        script: './dist/index.js',
        watch: ['src/**'],
        ext: 'js ts',
        tasks: files => {
            // eslint-disable-next-line no-console
            console.log(
                chalk.yellow(
                    '',
                    files.map(f => path.relative(process.cwd(), f)).join('\n')
                )
            )
            return ['build']
        },
        done: done,
        delay: '100',
    }).once('quit', function() {
        // eslint-disable-next-line no-console
        console.log(chalk.yellow('[nodemon] Quit.'))
        done()
        process.exit()
    })
}));
