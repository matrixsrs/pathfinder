/* GULP itself */
'use strict';

let fs                  = require('fs');
let ini                 = require('ini');

let gulp                = require('gulp');
let gutil               = require('gulp-util');
let requirejsOptimize   = require('gulp-requirejs-optimize');
let filter              = require('gulp-filter');
let gulpif              = require('gulp-if');
let jshint              = require('gulp-jshint');
let sourcemaps          = require('gulp-sourcemaps');
let gzip                = require('gulp-gzip');
let brotli              = require('gulp-brotli');
let uglifyjs            = require('uglify-es');
let composer            = require('gulp-uglify/composer');
let compass             = require('gulp-compass');
let cleanCSS            = require('gulp-clean-css');
let bytediff            = require('gulp-bytediff');
let debug               = require('gulp-debug');

// -- Helper & NPM modules ----------------------------------------------------
let flatten             = require('flat');
let padEnd              = require('lodash.padend');
let minimist            = require('minimist');
let slash               = require('slash');
let fileExtension       = require('file-extension');
let stylish             = require('jshint-stylish');
let Table               = require('terminal-table');
let prettyBytes         = require('pretty-bytes');
let del                 = require('promised-del');

let minify = composer(uglifyjs, console);
let chalk = gutil.colors;

// == Settings ========================================================================================================

// build/src directories
let PATH = {
    JS_HINT: {
        CONF:       '/.jshintrc'
    },
    ASSETS: {
        DIST:       './public'
    },
    JS: {
        SRC:        'js/**/*.js',
        SRC_LIBS:   './js/lib/**/*',
        DIST:       'public/js',
        DIST_BUILD: './public/js/vX.X.X'
    },
    CSS: {
        SRC: './sass/**/*.scss',
    }
};

// Pathfinder config file
let pathfinderConfigFile = './app/pathfinder.ini';

// CLI box size in characters
let cliBoxLength = 80;

// cache for already combined JS files
let combinedJsFiles = [];

// cache for tracked JS files
let trackedFiles = {};

// columns for tracked JS files (used for mapping)
let trackTable = {
    cols: [
        'file',
        'src',
        'src_percent',
        'uglify',
        'gzipFile',
        'gzip_percent',
        'gzip',
        'brotliFile',
        'brotli_percent',
        'brotli',
        'all_percent',
        'mapFile',
        'map'
    ]
};

// UglifyJS options
// https://www.npmjs.com/package/uglify-es
let uglifyJsOptions = {
    warnings: true,
    toplevel: false
};

// Sourcemaps options
// https://www.npmjs.com/package/gulp-sourcemaps

// -- Plugin options ----------------------------------------------------------

let gZipOptions = {
    append: false,                      // disables default append ext .gz
    extension: 'gz',                    // use "custom" ext: .gz
    threshold: '1kb',                   // min size required to compress a file
    deleteMode: PATH.JS.DIST_BUILD,     // replace *.gz files if size < 'threhold'
    gzipOptions: {
        level: 9                        // zlib.Gzip compression level [0-9]
    },
    skipGrowingFiles: true              // use orig. files in case of *.gz size > orig. size
};

let brotliOptions = {
    extension: 'br',                    // use "custom" ext: .br
    mode: 1,                            // compression mode for UTF-8 formatted text
    quality: 11,                        // quality [1 worst - 11 best]
    skipLarger: true                    // use orig. files in case of *.br size > orig. size
};

let compassOptions = {
    config_file: './config.rb',
    css: 'public/css',
    sass: 'sass',
    time: true,                         // show execution time
    sourcemap: true
};

let compressionExt = [gZipOptions.extension, brotliOptions.extension];

// -- Error output ------------------------------------------------------------

/**
 * print error box output
 * @param title
 * @param example
 */
let printError = (title, example) => {
    let cliLineLength = (cliBoxLength - 8);

    gutil.log('').log(chalk.red( '= ERROR ' + '=' . repeat(cliLineLength)));
    gutil.log(chalk.red(title));
    if(example){
        gutil.log(`
             ${chalk.gray(example)}
        `);
    }
    gutil.log(chalk.red('='.repeat(cliBoxLength))).log('');
};

// == Settings ========================================================================================================

// parse pathfinder.ini config file for relevant data
let tagVersion;
try{
    let pathfinderIni = ini.parse(fs.readFileSync(pathfinderConfigFile, 'utf-8'));
    try{
        tagVersion = pathfinderIni.PATHFINDER.VERSION;
    }catch(err){
        printError(
            err.message,
            'Missing "PATHFINDER.VERSION" in "' + pathfinderConfigFile + '"');
        process.exit(1);
    }
}catch(err){
    printError(
        err.message,
        'Check read permissions for "' + pathfinderConfigFile + '"');
    process.exit(1);
}

// parse CLI parameters
let options = minimist(process.argv.slice(2));

// custom task configuration (user CLI options if provided) (overwrites default)
let CONF = {
    TASK: options.hasOwnProperty('_') ? options._[0] : undefined,
    TAG: options.tag ? options.tag : tagVersion ? tagVersion : undefined,
    JS: {
        UGLIFY: options.hasOwnProperty('jsUglify') ? options.jsUglify === 'true': undefined,
        SOURCEMAPS: options.hasOwnProperty('jsSourcemaps') ? options.jsSourcemaps === 'true': undefined,
    },
    CSS: {
        SOURCEMAPS: options.hasOwnProperty('cssSourcemaps') ? options.cssSourcemaps === 'true': undefined,
    },
    GZIP: options.hasOwnProperty('gzip') ? options.gzip === 'true': undefined,
    BROTLI: options.hasOwnProperty('brotli') ? options.brotli === 'true': undefined,
    DEBUG: false
};

// == Helper methods ==================================================================================================

/**
 * track a file by size and filename, provide a mapping (see trackTable)
 * @param data
 * @param mapping
 */
let trackFile = (data, mapping) => {
    let fileNameParts = data.fileName.split('.');
    let fileExt = fileNameParts.pop();
    let srcFileName = compressionExt.concat(['map']).includes(fileExt) ? fileNameParts.join('.') : data.fileName;
    let fileData = trackedFiles[srcFileName] || [];

    // change mapping for *.map files
    switch(fileExt){
        case 'js':
            mapping.all_percent = 'percent';
            break;
        case 'map':
            mapping = {mapFile: 'fileName', map: 'endSize'};
            break;
        case gZipOptions.extension:
            data.all_percent = data.endSize / fileData[0];
            mapping = {gzipFile: 'fileName', gzip_percent: 'percent', gzip: 'endSize', all_percent: 'all_percent'};
            break;
        case brotliOptions.extension:
            data.all_percent = data.endSize / fileData[0];
            mapping = {brotliFile: 'fileName', brotli_percent: 'percent', brotli: 'endSize', all_percent: 'all_percent'};
            break;
    }

    for(let col in mapping){
        for(let i = 0; i < trackTable.cols.length; i++){
            if(trackTable.cols[i] === col){
                fileData[i - 1] = data[mapping[col]];
                break;
            }
        }
    }

    trackedFiles[srcFileName] = fileData;
};

/**
 * recursive "merge" two config objects
 * @param confUser
 * @param confDefault
 * @returns {*}
 */
let mergeConf = (confUser, confDefault) => {
    for (let confKey in confUser) {
        if (confUser.hasOwnProperty(confKey)){
            if(confDefault.hasOwnProperty(confKey)){
                if(
                    typeof confUser[confKey] === 'object' &&
                    typeof confDefault[confKey] === 'object'
                ){
                    confUser[confKey] = mergeConf(confUser[confKey], confDefault[confKey]);
                }else if(typeof confUser[confKey] === 'undefined'){
                    confUser[confKey] = confDefault[confKey];
                }
            }
        }
    }

    return confUser;
};

// == CLI output ======================================================================================================

/**
 * print help information for all Gulp tasks
 */
let printHelp = () => {
    let cliLineLength = (cliBoxLength - 7);
    gutil.log('')
        .log(chalk.cyan( '= HELP ' + '='.repeat(cliLineLength)))
        .log(`
             ${chalk.cyan('documentation:')}        ${chalk.gray('https://github.com/exodus4d/pathfinder/wiki/GulpJs')}
             
             ${chalk.cyan('usage:')}                ${chalk.gray('$ npm run gulp [task] -- [--options] ...')}
             
             ${chalk.cyan('tasks:')}
                ${chalk.gray('help')}               This view
                ${chalk.gray('default')}            Development environment. Working with row src files and file watcher, default:
                ${chalk.gray('')}                       ${chalk.gray('--jsUglify=false --jsSourcemaps=false --cssSourcemaps=false --gzip=false --brotli=false')}
                ${chalk.gray('production')}         Production build. Concat and uglify static resources, default:
                ${chalk.gray('')}                       ${chalk.gray('--jsUglify=true --jsSourcemaps=true --cssSourcemaps=true --gzip=true --brotli=true')}
             
             ${chalk.cyan('options:')}
                 ${chalk.gray('--tag')}             Set build version.              ${chalk.gray('default: --tag="v1.2.4" -> dest path: public/js/v1.2.4')}
                 ${chalk.gray('--jsUglify')}        Set js uglification.            ${chalk.gray('(true || false)')}
                 ${chalk.gray('--jsSourcemaps')}    Set js sourcemaps generation.   ${chalk.gray('(true || false)')}
                 ${chalk.gray('--cssSourcemaps')}   Set CSS sourcemaps generation.  ${chalk.gray('(true || false)')}
                 ${chalk.gray('--gzip')}            Set "gzip" compression mode.    ${chalk.gray('(true || false)')}
                 ${chalk.gray('--brotli')}          Set "brotli" compression mode.  ${chalk.gray('(true || false)')}
                 ${chalk.gray('--debug')}           Set debug mode (more output).   ${chalk.gray('(true || false)')}
        `)
        .log(chalk.cyan('='.repeat(cliBoxLength)))
        .log('');
};

/**
 * print JS summary table
 */
let printJsSummary = () => {
    let tableHead = trackTable.cols;
    let byteCols = [1,3,6,9,12];
    let percentCols = [2, 5, 8, 10];
    let sortCol = (CONF.BROTLI || CONF.GZIP || CONF.JS.UGLIFY) ? 10 : CONF.JS.SOURCEMAPS ? 3 : 1;
    let refAllCol = CONF.BROTLI ? 9 : CONF.GZIP ? 6 : CONF.JS.UGLIFY ? 3 : CONF.JS.SOURCEMAPS ? 3 : 1;
    let highLightSections = {src_percent: [], gzip_percent: [], brotli_percent: [], all_percent: []};
    let highLightRow = {
        success: JSON.parse(JSON.stringify(highLightSections)),
        warning: JSON.parse(JSON.stringify(highLightSections)),
        danger: JSON.parse(JSON.stringify(highLightSections))
    };

    let numFormatCols = byteCols.concat(percentCols);
    let sumRow = [];
    let widthCol = [35, 10, 8, 10, 35, 8, 10, 35, 8, 10, 8, 35, 10];

    let table = new Table({
        borderStyle: 2,
        horizontalLine: true,
        width: widthCol,
        rightPadding: 0,
        leftPadding: 0
    });

    // -- Table header --------------------------------------------------------
    table.push(tableHead.map(label => label.replace(/^(.*?)_(percent?).*/i, '$1 %')));

    // convert JSON to array
    let tableData = [];
    for (let fileName in trackedFiles) {
        let rowData = trackedFiles[fileName];
        rowData.unshift(fileName);
        tableData.push(rowData);
    }

    let tableHeight = tableData.length + 1;
    let tableWidth = tableHead.length;

    tableData.sort((a,b) => a[sortCol] - b[sortCol]);

    table.attr(0, sortCol, {
        color: 'cyan'
    });

    // -- Table body ----------------------------------------------------------
    let tmpMapping =  {byteCols: byteCols, percentCols: percentCols};

    // sum column data for footer
    let sumCols = (arr, mapping) => arr.map((x, rowIdx) =>
        x.map((y, i) => {
            if(mapping.byteCols.includes(i)) {
                sumRow[i] = (sumRow[i]) ? sumRow[i] + y : y;
            }
            return y;
        })
    );

    // format table cell data
    let formatCols = (arr, mapping) => arr.map((x, rowIdx) =>
        x.map((y, i) => {
            if(mapping.byteCols.includes(i)) {
                return prettyBytes(y);
            }else if(mapping.percentCols.includes(i)){
                // 0.0% diff is "success" in case of Uglify is disabled
                let isSuccess = (
                    y === 1 &&
                    !CONF.JS.UGLIFY &&
                    tableHead[i] === 'src_percent'
                );

                if(y < 0.3 || isSuccess) {
                    highLightRow.success[tableHead[i]].push(rowIdx);
                }else if(y < 0.5 ){
                    highLightRow.warning[tableHead[i]].push(rowIdx);
                }else{
                    highLightRow.danger[tableHead[i]].push(rowIdx);
                }

                return y ? (100 * (1 - y )).toFixed(1) + '%' : '';
            }else{
                return y;
            }
        })
    );

    tableData = sumCols(tableData, tmpMapping);

    // -- Table footer --------------------------------------------------------
    // percent cell src
    sumRow[2] = ((sumRow[3] / sumRow[1]));
    // percent cell gzip
    sumRow[5] = (((sumRow[6] || 0) / sumRow[3]));
    // percent cell brotli
    sumRow[8] = (((sumRow[9] || 0) / sumRow[3]));
    // percent cell all
    sumRow[10] = (((sumRow[refAllCol] || 0) / sumRow[1]));

    tableData.push(sumRow);
    tableData = formatCols(tableData, tmpMapping);

    // add rows
    for(let i = 0; i < tableData.length; i++){
        table.push(tableData[i]);
    }

    // -- Table format --------------------------------------------------------
    for(let i = 0; i < numFormatCols.length; i++){
        table.attrRange({row: [0], column: [numFormatCols[i], numFormatCols[i] + 1]}, {
            align: 'right',
            rightPadding: 1
        });
    }

    for (let highLight in highLightRow) {
        if (highLightRow.hasOwnProperty(highLight)){
            for (let highLightSection in highLightRow[highLight]) {
                for(let i = 0; i < highLightRow[highLight][highLightSection].length; i++){
                    let rowIdx = highLightRow[highLight][highLightSection][i];

                    let color = (highLight === 'success') ? 'green' : (highLight === 'warning') ? 'yellow' : 'red';
                    let colFrom = 0;
                    let colTo = 1;
                    switch(highLightSection){
                        case 'src_percent':
                            colTo = 1;
                            colTo = 4;
                            break;
                        case 'gzip_percent':
                            colFrom = 4;
                            colTo = 7;
                            break;
                        case 'brotli_percent':
                            colFrom = 7;
                            colTo = 10;
                            break;
                        case 'all_percent':
                            colFrom = 10;
                            colTo = 11;
                            break;
                    }
                    table.attrRange({row: [rowIdx + 1, rowIdx + 2], column: [colFrom, colTo]},{
                        color: color
                    });
                }
            }
        }
    }

    // -- Remove irrelevant columns -------------------------------------------

    if(!CONF.JS.SOURCEMAPS){
        table.removeColumn(12);
        table.removeColumn(11);

        if(!CONF.BROTLI && !CONF.GZIP){
            table.removeColumn(10);

            table.removeColumn(9);
            table.removeColumn(8);
            table.removeColumn(7);

            table.removeColumn(6);
            table.removeColumn(5);
            table.removeColumn(4);

            if(!CONF.JS.UGLIFY){
                table.removeColumn(3);
                table.removeColumn(2);
            }
        }
    }

    console.log(table.toString());

    // reset tracked files for next run e.g. watch change
    trackedFiles = {};
};

// == clean up tasks ==================================================================================================

/**
 * clean temp JS build dir
 */
gulp.task('task:cleanJsBuild', () => del([PATH.JS.DIST_BUILD]));
/**
 * clean CSS build dir
 */
gulp.task('task:cleanCssBuild', () => del([PATH.ASSETS.DIST + '/css']));

/**
 * clean JS destination (final) dir
 */
gulp.task('task:cleanJsDest', () => del([PATH.JS.DIST + '/' + CONF.TAG]));

// == Dev tasks (code analyses) =======================================================================================
gulp.task('task:hintJS', () => {
    return gulp.src([PATH.JS.SRC, '!' + PATH.JS.SRC_LIBS])
        .pipe(jshint(__dirname + PATH.JS_HINT.CONF))
        .pipe(jshint.reporter(stylish));
});

// == JS build tasks ==================================================================================================

/**
 * concat/build JS files by modules
 */
gulp.task('task:concatJS', () => {
    let modules = ['login', 'mappage', 'setup', 'admin', 'notification'];
    let srcModules = ['./js/app/*(' + modules.join('|') + ').js'];

    return gulp.src(srcModules, {base: 'js'})

        .pipe(gulpif(CONF.JS.SOURCEMAPS, sourcemaps.init()))
        .pipe(requirejsOptimize(function(file){

            return {
                name: file.stem,
                baseUrl: 'js',
                mainConfigFile: './js/app.js',
                optimize: 'none',
                inlineText: false,
                removeCombined: true,
                preserveLicenseComments: false,     // required for sourcemaps
                findNestedDependencies: false,
                include: ['text'],
             // excludeShallow: ['app'],
             // excludeShallow: ['./js/app.js'],
             // exclude: ['app.js'],
             // path: {
             //     pp: './../js/app' // the main config file will not be build
             // },
                onModuleBundleComplete: function(data){
                    // collect all combined js files
                    combinedJsFiles = [...new Set(combinedJsFiles.concat(data.included))];
                }
            };
        }))
        .pipe(bytediff.start())
        .pipe(gulpif(CONF.JS.UGLIFY, minify(uglifyJsOptions).on('warnings', gutil.log)))
        .pipe(gulpif(CONF.JS.SOURCEMAPS, sourcemaps.write('.', {includeContent: false, sourceRoot: '/js'}))) // prod (minify)
        .pipe(bytediff.stop(data => {
            trackFile(data, {src: 'startSize', src_percent: 'percent', uglify: 'endSize'});
            return chalk.green('Build concat file "' + data.fileName + '"');
        }))
        .pipe(gulp.dest(PATH.JS.DIST_BUILD));
});

/**
 * build standalone JS files
 */
gulp.task('task:diffJS', () => {
    return gulp.src(PATH.JS.SRC, {base: 'js', since: gulp.lastRun('task:diffJS')})
        .pipe(filter(file => {
            return combinedJsFiles.indexOf(slash(file.path)) < 0;
        }))
        .pipe(debug({title: 'Copy JS src: ', showFiles: false}))
        .pipe(bytediff.start())
        .pipe(gulpif(CONF.JS.SOURCEMAPS, sourcemaps.init()))
        .pipe(gulpif(CONF.JS.UGLIFY, minify(uglifyJsOptions)))
        .pipe(gulpif(CONF.JS.SOURCEMAPS, sourcemaps.write('.', {includeContent: false, sourceRoot: '/js'})))
        .pipe(bytediff.stop(data => {
            trackFile(data, {src: 'startSize', src_percent: 'percent', uglify: 'endSize'});
            return chalk.green('Build file "' + data.fileName + '"');
        }))
        .pipe(gulp.dest(PATH.JS.DIST_BUILD, {overwrite: false}));
});

gulp.task('task:gzipAssets', () => {
    let filterGzip = filter(file => CONF.GZIP);
    let fileExt = ['js', 'css'];
    let srcModules = [
        PATH.ASSETS.DIST +'/**/*.{' + fileExt.join(',') + '}',
        '!' + PATH.ASSETS.DIST + '/js/' + CONF.TAG + '{,/**/*}'
    ];

    return gulp.src(srcModules, {base: 'public', since: gulp.lastRun('task:gzipAssets')})
        .pipe(filterGzip)
        .pipe(debug({title: 'Gzip asses dest: ', showFiles: false}))
        .pipe(bytediff.start())
        .pipe(gzip(gZipOptions))
        .pipe(bytediff.stop(data => {
            trackFile(data, {gzipFile: 'fileName', gzip: 'endSize'});
            if(fileExtension(data.fileName) === gZipOptions.extension){
                return chalk.green('Gzip generate "' + data.fileName + '"');
            }else{
                return chalk.gray('Gzip skip "' + data.fileName + '". Size < ' + gZipOptions.threshold + ' (threehold)');
            }
        }))
        .pipe(gulp.dest(PATH.ASSETS.DIST));
});

gulp.task('task:brotliAssets', () => {
    let filterBrotli = filter(file => CONF.BROTLI);
    let fileExt = ['js', 'css'];
    let srcModules = [
        PATH.ASSETS.DIST +'/**/*.{' + fileExt.join(',') + '}',
        '!' + PATH.ASSETS.DIST + '/js/' + CONF.TAG + '{,/**/*}'
    ];

    return gulp.src(srcModules, {base: 'public', since: gulp.lastRun('task:brotliAssets')})
        .pipe(filterBrotli)
        .pipe(debug({title: 'Brotli asses dest: ', showFiles: false}))
        .pipe(bytediff.start())
        .pipe(brotli.compress(brotliOptions))
        .pipe(bytediff.stop(data => {
            trackFile(data, {brotliFile: 'fileName', brotli: 'endSize'});
            if(fileExtension(data.fileName) ===  brotliOptions.extension){
                return chalk.green('Brotli generate "' + data.fileName + '"');
            }else{
                return chalk.gray('Brotli skip "' + data.fileName + '"');
            }
        }))
        .pipe(gulp.dest(PATH.ASSETS.DIST));
});

/**
 * rename "temp" build JS folder to final dist folder
 * (keep "old" build data as long as possible in case of build failure)
 */
gulp.task('task:renameJsDest', () => {
    let fileExt = ['js', 'map'].concat(compressionExt);
    return gulp.src( PATH.JS.DIST_BUILD + '/**/*.{' + fileExt.join(',') + '}', {base: PATH.JS.DIST_BUILD, since: gulp.lastRun('task:renameJsDest')})
        .pipe(debug({title: 'Rename JS dest: ', showFiles: false}))
        .pipe(gulp.dest(PATH.JS.DIST_BUILD + '/../' + CONF.TAG));
});

/**
 * build CSS rom SASS files (Compass)
 */
gulp.task('task:sass', () => {
    compassOptions.sourcemap = CONF.CSS.SOURCEMAPS;

    return gulp.src( './sass/**/*.scss')
        .pipe(compass(compassOptions))
        .pipe(bytediff.start())
        .pipe(bytediff.stop(data => {
            trackFile(data, {src: 'startSize', src_percent: 'percent', uglify: 'endSize'});
            return chalk.green('Build CSS file "' + data.fileName + '"');
        }))
        .pipe(gulp.dest(PATH.ASSETS.DIST + '/css'));
});

/**
 * css-clean can be used to "optimize" generated CSS [optional]
 */
gulp.task('task:cleanCss', () => {
    return gulp.src( PATH.ASSETS.DIST +'/css/**/*.css')
        .pipe(cleanCSS({
            compatibility: '*',
            level: 2
        }))
        .pipe(gulp.dest(PATH.ASSETS.DIST +'/css'));
});

// == Helper tasks ====================================================================================================

/**
 * print Gulp help information
 */
gulp.task('task:printHelp', done => {
    printHelp();
    done();
});

/**
 * print JS build task summary as table (e.g. show saved file size)
 */
gulp.task('task:printJsSummary', done => {
    printJsSummary();
    done();
});

/**
 * print task configuration (e.g. CLI parameters)
 */
gulp.task('task:printConfig', done => {
    let error = chalk.red;
    let success = chalk.green;

    let columnLength = Math.round(cliBoxLength / 2);
    let cliLineLength = cliBoxLength - 9;

    gutil.log(chalk.gray( '= CONFIG ' + '='.repeat(cliLineLength)));

    let configFlat = flatten(CONF);
    for (let key in configFlat) {
        if (configFlat.hasOwnProperty(key)){
            let value = configFlat[key];
            // format value
            value = padEnd((typeof value === 'undefined') ? 'undefined': value, columnLength);
            gutil.log(
                chalk.gray.yellow(padEnd(key, columnLength)),
                configFlat[key] ? success(value) : error(value)
            );
        }
    }
    gutil.log(chalk.reset.gray('='.repeat(cliBoxLength)));
    done();
});

/**
 * check CLI parameters and task config
 */
gulp.task('task:checkConfig', done => {
    if(!CONF.TAG){
        printError(
            'Missing TAG version. Add param ' + chalk.cyan('--tag'),
            '$ npm run gulp default -- --tag="v1.2.4"');
        process.exit(0);
    }
    done();
});

/**
 * configure "develop" task
 */
gulp.task('task:configDevelop',
    gulp.series(
        done => {
            let CONF_DEVELOP = {
                JS: {
                    UGLIFY: false,
                    SOURCEMAPS: false
                },
                CSS: {
                    SOURCEMAPS: false
                },
                GZIP: false,
                BROTLI: false
            };

            CONF = mergeConf(CONF, CONF_DEVELOP);
            done();
        },
        'task:printConfig',
        'task:checkConfig'
    )
);
/**
 * configure "production" task
 */
gulp.task('task:configProduction',
    gulp.series(
        done => {
            let CONF_PRODUCTION = {
                JS: {
                    UGLIFY: true,
                    SOURCEMAPS: true
                },
                CSS: {
                    SOURCEMAPS: true
                },
                GZIP: true,
                BROTLI: true
            };

            CONF = mergeConf(CONF, CONF_PRODUCTION);
            done();
        },
        'task:printConfig',
        'task:checkConfig'
    )
);

/**
 * updates JS destination move to (final) dir
 */
gulp.task('task:updateJsDest', gulp.series(
    'task:gzipAssets',
    'task:brotliAssets',
    'task:renameJsDest',
    'task:printJsSummary',
    'task:cleanJsBuild'
    )
);

/**
 * build JS source files (concat, uglify, sourcemaps)
 */
gulp.task('task:buildJs', gulp.series(
    'task:concatJS',
    'task:diffJS',
    'task:cleanJsDest',
    'task:updateJsDest'
    )
);

/**
 * build SCSS source files
 */
gulp.task('task:buildCss', gulp.series(
    'task:sass'
    )
);

// == Watcher tasks ===================================================================================================

/**
 * task for JS src file changes
 */
gulp.task(
    'task:watchJsSrc',
    gulp.series(
        'task:hintJS',
        'task:diffJS',
        'task:updateJsDest'
    )
);

/**
 * task for JS src file changes
 */
gulp.task(
    'task:watchCss',
    gulp.series(
        'task:buildCss',
       // 'task:cleanCss',
        'task:gzipAssets',
        'task:brotliAssets',
        'task:printJsSummary'
    )
);

/**
 * watch files for changes
 */
gulp.task('task:setWatcher', () => {
    gulp.watch(PATH.JS.SRC, gulp.series('task:watchJsSrc'));
    gulp.watch(PATH.CSS.SRC, gulp.series('task:watchCss'));
});

// == Default/Main tasks ==============================================================================================

gulp.task(
    'help',
    gulp.series(
        'task:printHelp'
    )
);

gulp.task(
    'default',
    gulp.series(
        'task:configDevelop',
        gulp.parallel(
            gulp.series(
                'task:cleanJsBuild',
                'task:watchJsSrc'
            ),
            gulp.series(
                'task:cleanCssBuild',
                'task:watchCss'
            ),
            'task:setWatcher'
        )
    )
);

gulp.task(
    'production',
    gulp.series(
        'task:configProduction',
        'task:cleanJsBuild',
        'task:cleanCssBuild',
        gulp.parallel(
            'task:buildJs',
            'task:watchCss'
        )
    )
);

