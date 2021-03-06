import Node from '../node';

import {Server} from '../server';
import {Mime} from '../mime';
import {Handler} from './handler';

export class FileRoute {
    private pattern:any;
    private location:any;
    constructor(settings){
        if(typeof settings=='string'){
            settings = [/^\/(.*)$/i,`${settings}/$1`];
        }
        this.pattern = settings.shift();
        this.location = settings.shift();
    }
    private match(url){
        if(url.match(this.pattern)){
            return url.replace(this.pattern,this.location);
        }
    }
    private toString(){
        return `Route(${this.pattern} -> ${this.location})`
    }
}

@Server.handler('files')
export class FileHandler extends Handler {
    config:any;
    routes:any;
    constructor(){
        super();
        this.config = FileHandler.config;
        this.routes = [];
        if(typeof this.config.path=='string'){
            this.config.path=[this.config.path];
        }
        this.config.path.forEach(p=>{
            this.routes.push(new FileRoute(p));
        });
    }
    private resource(path){
        try {
            var stat = Node.Fs.statSync(path);
            if (stat.isDirectory()) {
                return this.resource(Node.Path.resolve(path, 'index.html'));
            } else
            if (stat.isFile()) {
                return {exist:true,path:path};
            } else {
                return {exist:false,path:path};
            }
        }catch(e){
            return {exist:false,path:path};
        }
    }
    private accept(req,res){

    }
    private handle(req,res){
        var path = req.url.split('?')[0];
        for(var file,i=0;i<this.routes.length;i++){
            file = this.routes[i].match(path);
            if(file && (file = this.resource(file)).exist){
                break;
            }
        }
        if(file && file.exist){
            let status = 200;
            let cache = this.config.cache;

            let headers = {
                'Content-Type'  : Mime.getType(file.path)
            };
            if(cache){
                headers['Cache-Control']    = 'public, max-age=86400';
                headers['Expires']          = new Date(new Date().getTime()+86400000).toUTCString();
            }else {
                headers['Cache-Control']    = 'no-cache';
            }

            res.stream = Node.Fs.createReadStream(file.path);
            var ae = req.headers['accept-encoding'];
            if(ae && ae.indexOf('gzip')>=0){
                headers['Content-Encoding']='gzip';
                res.stream = res.stream.pipe(Node.Zlib.createGzip());
            }
            res.writeHead(status,headers);

        }else{
            res.writeHead(404,{
                'Content-Type' : Mime.getType(file?file.path:req.url)
            });
            res.end('File Not Found');
        }
    }
}