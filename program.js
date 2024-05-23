const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs'); 


async function processVideo(url) {
    try {

      console.log('0. Downloading background image and image4k............................'); 
      await execPromise(`curl -L -o background.jpeg "https://drive.google.com/uc?export=download&id=1Vw-rE16jY5N5VakpAcGpV4o3DVig1Mg9"`); 
      await execPromise(`curl -L -o image4k.png "https://drive.google.com/uc?export=download&id=1uRnfHCvjsYVbUix1dQdZLL1Bjok8pXLp"`); 

      console.log('1. Downloading thumbnail..........................................');
      await execPromise(`yt-dlp --write-thumbnail --convert-thumbnail webp -o overlay --skip-download ${url}`);
  
      console.log('2. Downloading video.............................................');
      await execPromise(`yt-dlp -o ogvideo ${url}`);
  
      console.log('3. Creating new thumbnail........................................'); // Log before sync operation
      execSync(`ffmpeg -i background.jpeg -i overlay.webp -filter_complex "[1]scale=874:462[ovr];[0][ovr] overlay=279:147" finalthumbnail.jpeg`);
  
      console.log('4. Separating audio and video...........................................'); // Log before sync operation
      execSync(`ffmpeg -i ogvideo.webm -map 0:v -c:v copy ogvideo_only.webm -map 0:a -c:a copy ogaudio_only.webm`);
  
      console.log('5. Enhancing audio...................................................'); // Log before sync operation
      execSync(`ffmpeg -i ogaudio_only.webm -filter_complex "aecho=0.7:0.8:300:0.2,afftdn=nf=-20,firequalizer=gain_entry='entry(100,14);entry(200,7);entry(400,3.5)',aresample=48000" -c:a libvorbis finalaudio_only.webm`);
  
      console.log('6. Converting video to 360 video.............................................'); // Log before sync operation
      execSync(`ffmpeg -i image4k.png -i ogvideo_only.webm -filter_complex "[1:v]scale=w=521:h=257[scaled]; [0:v][scaled]overlay=697:890" -codec:a copy finalvideo_only.mp4`);
  
      console.log('7. Merging audio and video...............................................'); // Log before sync operation
      execSync(`ffmpeg -i finalvideo_only.mp4 -i finalaudio_only.webm -c copy finaloutput.mp4`);
  
      console.log('8. Adding 360 metadata for youtube....................................................'); // Log before sync operation
      execSync(`exiftool -XMP-GSpherical:Spherical="true" -XMP-GSpherical:Stitched="true" -XMP-GSpherical:ProjectionType="equirectangular" -XMP:StitchingSoftware="Spherical Metadata Tool" finaloutput.mp4`);
      
      console.log('9. Deleting temporary files...');
    const filesToDelete = [
        'overlay.webp', 
        'background.jpeg',
        'image4k.png',
        'finalvideo_only.mp4', 
        'finalaudio_only.webm', 
        'ogaudio_only.webm', 
        'ogvideo_only.webm', 
        'ogvideo.webm', 
        'finaloutput.mp4_original' 
    ];
    filesToDelete.forEach(file => {
        if (fs.existsSync(file)) { 
            fs.unlinkSync(file); 
        } else {
            console.warn(`File not found: ${file}`);
        }
    });

      console.log('10. Video processing complete................................................!');
    } catch (error) {
      console.error('Error processing video:', error);
    }
  }

// Helper function to promisify exec (unchanged)
function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout); 
      }
    });
  });
}

// Get YouTube URL from command line arguments
const youtubeUrl = process.argv[2]; 
processVideo(youtubeUrl);
