const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const YouTube = require('youtube-sr').default;
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

const queue = new Map();

class MusicQueue {
    constructor() {
        this.songs = [];
        this.connection = null;
        this.player = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.textChannel = null;
        this.songStartTime = null;
        this.pausedTime = 0; // Track total paused time
        this.pauseStartTime = null; // Track when pause started
        this.previousSongs = [];
        this.nowPlayingMessages = new Map(); // Store active nowplaying messages
        this.updateInterval = null;
        this.currentView = 'nowplaying'; // 'nowplaying' or 'queue'
    }
}

client.once('clientReady', async () => {
    console.log(`🎵 ${client.user.tag} is online and ready to play music!`);
    
    const commands = [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Play a song or playlist from YouTube')
            .addStringOption(option =>
                option.setName('query')
                    .setDescription('YouTube URL, playlist URL, or search query')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('skip')
            .setDescription('Skip the current song'),
        new SlashCommandBuilder()
            .setName('rewind')
            .setDescription('Go to previous song (if within 10s) or restart current song'),
        new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Stop music and clear queue'),
        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Clear the entire queue (keeps current song playing)'),
        new SlashCommandBuilder()
            .setName('queue')
            .setDescription('Show the current queue'),
        new SlashCommandBuilder()
            .setName('nowplaying')
            .setDescription('Show now playing with interactive controls'),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show available commands')
    ].map(command => command.toJSON());

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    }
});

async function handleSlashCommand(interaction) {

    const guildQueue = queue.get(interaction.guild.id);

    if (interaction.commandName === 'play') {
        if (!interaction.member.voice.channel) {
            return interaction.reply('❌ You need to be in a voice channel to play music!');
        }

        const query = interaction.options.getString('query');
        
        await interaction.deferReply();
        
        try {
            // Check if it's a playlist URL
            const isPlaylistUrl = query.includes('list=') && query.includes('youtube.com');
            
            if (isPlaylistUrl) {
                await interaction.editReply('🔄 Loading playlist... This may take a moment.');
                
                const playlist = await YouTube.getPlaylist(query);
                const playlistVideos = await playlist.fetch();
                
                if (!playlistVideos || playlistVideos.videos.length === 0) {
                    return interaction.editReply('❌ No videos found in this playlist!');
                }
                
                const songs = [];
                let loadedCount = 0;
                let errorCount = 0;
                
                for (const video of playlistVideos.videos.slice(0, 50)) { // Limit to 50 songs to prevent spam
                    try {
                        const songInfo = await ytdl.getInfo(video.url);
                        songs.push({
                            title: songInfo.videoDetails.title,
                            url: songInfo.videoDetails.video_url,
                            duration: songInfo.videoDetails.lengthSeconds,
                            thumbnail: songInfo.videoDetails.thumbnails[0]?.url,
                            requestedBy: interaction.user
                        });
                        loadedCount++;
                    } catch (error) {
                        console.error(`Error loading video ${video.title}:`, error);
                        errorCount++;
                    }
                }
                
                if (songs.length === 0) {
                    return interaction.editReply('❌ Could not load any songs from this playlist!');
                }
                
                // Add all songs to queue
                if (!guildQueue) {
                    const queueContract = new MusicQueue();
                    queueContract.textChannel = interaction.channel;
                    queue.set(interaction.guild.id, queueContract);
                    
                    queueContract.songs.push(...songs);
                    
                    try {
                        const connection = joinVoiceChannel({
                            channelId: interaction.member.voice.channel.id,
                            guildId: interaction.guild.id,
                            adapterCreator: interaction.guild.voiceAdapterCreator,
                        });

                        queueContract.connection = connection;
                        queueContract.player = createAudioPlayer();
                        connection.subscribe(queueContract.player);

                        connection.on(VoiceConnectionStatus.Ready, () => {
                            console.log('Voice connection is ready!');
                        });

                        queueContract.player.on(AudioPlayerStatus.Idle, async () => {
                            const finishedSong = queueContract.songs.shift();
                            if (finishedSong) {
                                queueContract.previousSongs.push(finishedSong);
                                if (queueContract.previousSongs.length > 10) {
                                    queueContract.previousSongs.shift();
                                }
                            }
                            
                            if (queueContract.songs.length > 0) {
                                playSong(interaction.guild, queueContract.songs[0], false);
                            } else {
                                await cleanupNowPlayingMessages(queueContract);
                                queueContract.connection.destroy();
                                queue.delete(interaction.guild.id);
                            }
                        });

                        queueContract.player.on('error', error => {
                            console.error('Audio player error:', error);
                            queueContract.textChannel.send('❌ An error occurred while playing the song.');
                        });

                        playSong(interaction.guild, queueContract.songs[0]);
                        const errorText = errorCount > 0 ? ` (${errorCount} songs failed to load)` : '';
                        interaction.editReply(`🎵 **${playlist.title}** playlist loaded! Added ${loadedCount} songs to queue${errorText}`);
                    } catch (error) {
                        console.error('Error connecting to voice channel:', error);
                        queue.delete(interaction.guild.id);
                        return interaction.editReply('❌ I could not join the voice channel!');
                    }
                } else {
                    guildQueue.songs.push(...songs);
                    const errorText = errorCount > 0 ? ` (${errorCount} songs failed to load)` : '';
                    interaction.editReply(`🎵 **${playlist.title}** playlist loaded! Added ${loadedCount} songs to queue${errorText}`);
                }
                return;
            }
            
            let songInfo;
            let videoUrl;
            
            if (ytdl.validateURL(query)) {
                songInfo = await ytdl.getInfo(query);
                videoUrl = query;
            } else {
                const searchResults = await YouTube.search(query, { limit: 1, type: 'video' });
                if (!searchResults || searchResults.length === 0) {
                    return interaction.editReply('❌ No search results found!');
                }
                
                const firstResult = searchResults[0];
                videoUrl = firstResult.url;
                songInfo = await ytdl.getInfo(videoUrl);
            }

            const song = {
                title: songInfo.videoDetails.title,
                url: songInfo.videoDetails.video_url,
                duration: songInfo.videoDetails.lengthSeconds,
                thumbnail: songInfo.videoDetails.thumbnails[0]?.url,
                requestedBy: interaction.user
            };

            if (!guildQueue) {
                const queueContract = new MusicQueue();
                queueContract.textChannel = interaction.channel;

                queue.set(interaction.guild.id, queueContract);

                queueContract.songs.push(song);

                try {
                    const connection = joinVoiceChannel({
                        channelId: interaction.member.voice.channel.id,
                        guildId: interaction.guild.id,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                    });

                    queueContract.connection = connection;
                    queueContract.player = createAudioPlayer();

                    connection.subscribe(queueContract.player);

                    connection.on(VoiceConnectionStatus.Ready, () => {
                        console.log('Voice connection is ready!');
                    });

                    queueContract.player.on(AudioPlayerStatus.Idle, async () => {
                        const finishedSong = queueContract.songs.shift();
                        if (finishedSong) {
                            queueContract.previousSongs.push(finishedSong);
                            // Keep only the last 10 previous songs
                            if (queueContract.previousSongs.length > 10) {
                                queueContract.previousSongs.shift();
                            }
                        }
                        
                        if (queueContract.songs.length > 0) {
                            playSong(interaction.guild, queueContract.songs[0], false);
                        } else {
                            await cleanupNowPlayingMessages(queueContract);
                            queueContract.connection.destroy();
                            queue.delete(interaction.guild.id);
                        }
                    });

                    queueContract.player.on('error', error => {
                        console.error('Audio player error:', error);
                        queueContract.textChannel.send('❌ An error occurred while playing the song.');
                    });

                    playSong(interaction.guild, queueContract.songs[0]);
                    interaction.editReply(`🎵 **${song.title}** is now playing!`);
                } catch (error) {
                    console.error('Error connecting to voice channel:', error);
                    queue.delete(interaction.guild.id);
                    return interaction.editReply('❌ I could not join the voice channel!');
                }
            } else {
                guildQueue.songs.push(song);
                interaction.editReply(`🎵 **${song.title}** has been added to the queue!`);
            }
        } catch (error) {
            console.error('Error playing song:', error);
            interaction.editReply('❌ There was an error playing that song!');
        }
    } else if (interaction.commandName === 'skip') {
        if (!interaction.member.voice.channel) {
            return interaction.reply('❌ You need to be in a voice channel to skip music!');
        }
        if (!guildQueue) {
            return interaction.reply('❌ There is no song playing!');
        }

        guildQueue.player.stop();
        interaction.reply('⏭️ Song skipped!');
    } else if (interaction.commandName === 'rewind') {
        if (!interaction.member.voice.channel) {
            return interaction.reply('❌ You need to be in a voice channel to rewind music!');
        }
        if (!guildQueue || guildQueue.songs.length === 0) {
            return interaction.reply('❌ There is no song playing!');
        }

        const currentTime = Date.now();
        const timeSinceStart = guildQueue.songStartTime ? (currentTime - guildQueue.songStartTime) / 1000 : 0;

        if (timeSinceStart <= 10 && guildQueue.previousSongs.length > 0) {
            // Go to previous song
            const previousSong = guildQueue.previousSongs.pop();
            guildQueue.songs.unshift(previousSong);
            guildQueue.player.stop();
            
            setTimeout(() => {
                playSong(interaction.guild, guildQueue.songs[0]);
            }, 100);
            
            interaction.reply('⏮️ Playing previous song!');
        } else {
            // Restart current song
            const currentSong = guildQueue.songs[0];
            guildQueue.player.stop();
            
            setTimeout(() => {
                playSong(interaction.guild, currentSong);
            }, 100);
            
            interaction.reply('⏪ Song restarted!');
        }
    } else if (interaction.commandName === 'clear') {
        if (!interaction.member.voice.channel) {
            return interaction.reply('❌ You need to be in a voice channel to clear the queue!');
        }
        if (!guildQueue || guildQueue.songs.length <= 1) {
            return interaction.reply('❌ The queue is already empty!');
        }

        const currentSong = guildQueue.songs[0];
        guildQueue.songs = [currentSong];
        interaction.reply('🗑️ Queue cleared! Current song will continue playing.');
    } else if (interaction.commandName === 'stop') {
        if (!interaction.member.voice.channel) {
            return interaction.reply('❌ You need to be in a voice channel to stop music!');
        }
        if (!guildQueue) {
            return interaction.reply('❌ There is no song playing!');
        }

        guildQueue.songs = [];
        guildQueue.player.stop();
        await cleanupNowPlayingMessages(guildQueue);
        guildQueue.connection.destroy();
        queue.delete(interaction.guild.id);
        interaction.reply('⏹️ Music stopped and queue cleared!');
    } else if (interaction.commandName === 'queue') {
        if (!guildQueue || guildQueue.songs.length === 0) {
            return interaction.reply('❌ The queue is empty!');
        }

        const queueList = guildQueue.songs.slice(0, 10).map((song, index) => 
            `${index === 0 ? '🎵 Now Playing:' : `${index}.`} **${song.title}** - Requested by ${song.requestedBy.username}`
        ).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('📋 Current Queue')
            .setDescription(queueList + (guildQueue.songs.length > 10 ? `\n...and ${guildQueue.songs.length - 10} more songs` : ''))
            .setTimestamp();
            
        interaction.reply({ embeds: [embed] });
    } else if (interaction.commandName === 'nowplaying') {
        if (!guildQueue || guildQueue.songs.length === 0) {
            return interaction.reply('❌ There is no song currently playing!');
        }

        const { embed, row } = createEmbed(guildQueue);

        await interaction.reply({ embeds: [embed], components: [row] });
        const response = await interaction.fetchReply();
        
        // Store this message for auto-updates
        guildQueue.nowPlayingMessages.set(response.id, {
            channelId: interaction.channelId,
            messageId: response.id,
            userId: interaction.user.id
        });
        
        // Start auto-update interval if not already running
        if (!guildQueue.updateInterval) {
            startNowPlayingUpdates(interaction.guild.id);
        }
    } else if (interaction.commandName === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('🎵 Music Bot Commands')
            .addFields(
                { name: '/play <query>', value: 'Play a song or playlist from YouTube URL, playlist URL, or search query', inline: false },
                { name: '/skip', value: 'Skip the current song', inline: false },
                { name: '/rewind', value: 'Go to previous song (if within 10s) or restart current song', inline: false },
                { name: '/stop', value: 'Stop music and clear queue', inline: false },
                { name: '/clear', value: 'Clear the entire queue (keeps current song playing)', inline: false },
                { name: '/queue', value: 'Show the current queue', inline: false },
                { name: '/nowplaying', value: 'Show now playing with interactive controls', inline: false },
                { name: '/help', value: 'Show this help message', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: 'Noibat Music Bot' });

        interaction.reply({ embeds: [helpEmbed] });
    }
}

async function handleButtonInteraction(interaction) {
    const guildQueue = queue.get(interaction.guild.id);
    
    if (!guildQueue || guildQueue.songs.length === 0) {
        return interaction.reply({ content: '❌ There is no song currently playing!', flags: 64 });
    }

    if (!interaction.member.voice.channel) {
        return interaction.reply({ content: '❌ You need to be in a voice channel to control music!', flags: 64 });
    }

    switch (interaction.customId) {
        case 'playpause_btn':
            if (guildQueue.isPaused) {
                guildQueue.player.unpause();
                guildQueue.isPaused = false;
                // Add the paused duration to total paused time
                if (guildQueue.pauseStartTime) {
                    guildQueue.pausedTime += Date.now() - guildQueue.pauseStartTime;
                    guildQueue.pauseStartTime = null;
                }
            } else {
                guildQueue.player.pause();
                guildQueue.isPaused = true;
                guildQueue.pauseStartTime = Date.now();
            }
            
            // Update the current message with the new button state
            const { embed, row } = createEmbed(guildQueue);
            try {
                await interaction.update({ embeds: [embed], components: [row] });
            } catch (error) {
                console.error('Error updating embed after play/pause:', error);
            }
            break;

        case 'skip_btn':
            guildQueue.player.stop();
            await interaction.deferUpdate();
            break;

        case 'rewind_btn':
            const currentTime = Date.now();
            const timeSinceStart = guildQueue.songStartTime ? (currentTime - guildQueue.songStartTime) / 1000 : 0;

            if (timeSinceStart <= 10 && guildQueue.previousSongs.length > 0) {
                const previousSong = guildQueue.previousSongs.pop();
                guildQueue.songs.unshift(previousSong);
                guildQueue.player.stop();
                
                setTimeout(() => {
                    playSong(interaction.guild, guildQueue.songs[0], false);
                }, 100);
                
                await interaction.deferUpdate();
            } else {
                const currentSong = guildQueue.songs[0];
                guildQueue.player.stop();
                
                setTimeout(() => {
                    playSong(interaction.guild, currentSong, false);
                }, 100);
                
                await interaction.deferUpdate();
            }
            break;

        case 'view_toggle_btn':
            // Toggle between nowplaying and queue views
            guildQueue.currentView = guildQueue.currentView === 'nowplaying' ? 'queue' : 'nowplaying';
            
            const { embed: toggleEmbed, row: toggleRow } = createEmbed(guildQueue);
            try {
                await interaction.update({ embeds: [toggleEmbed], components: [toggleRow] });
            } catch (error) {
                console.error('Error updating embed after view toggle:', error);
            }
            break;
    }
}

function startNowPlayingUpdates(guildId) {
    const guildQueue = queue.get(guildId);
    if (!guildQueue) return;
    
    // Clear existing interval
    if (guildQueue.updateInterval) {
        clearInterval(guildQueue.updateInterval);
    }
    
    // Update every 10 seconds
    guildQueue.updateInterval = setInterval(async () => {
        await updateNowPlayingMessages(guildId);
    }, 5000);
}

async function updateNowPlayingMessages(guildId) {
    const guildQueue = queue.get(guildId);
    if (!guildQueue || guildQueue.songs.length === 0) {
        // Stop updates if no music is playing
        if (guildQueue?.updateInterval) {
            clearInterval(guildQueue.updateInterval);
            guildQueue.updateInterval = null;
        }
        return;
    }
    

    const { embed: updatedEmbed, row: updatedRow } = createEmbed(guildQueue);

    // Update all tracked nowplaying messages
    const messagesToRemove = [];
    for (const [messageId, messageData] of guildQueue.nowPlayingMessages) {
        try {
            const channel = client.channels.cache.get(messageData.channelId);
            if (channel) {
                const message = await channel.messages.fetch(messageData.messageId);
                if (message) {
                    await message.edit({ embeds: [updatedEmbed], components: [updatedRow] });
                } else {
                    messagesToRemove.push(messageId);
                }
            } else {
                messagesToRemove.push(messageId);
            }
        } catch (error) {
            console.error('Error updating message:', messageId, error.message);
            messagesToRemove.push(messageId);
        }
    }
    
    // Clean up deleted/invalid messages
    if (messagesToRemove.length > 0) {
        messagesToRemove.forEach(messageId => {
            guildQueue.nowPlayingMessages.delete(messageId);
        });
    }
    
    // Stop updates if no messages to update
    if (guildQueue.nowPlayingMessages.size === 0) {
        clearInterval(guildQueue.updateInterval);
        guildQueue.updateInterval = null;
    }
}

function createNowPlayingEmbed(guildQueue) {
    const currentSong = guildQueue.songs[0];
    
    // Calculate actual playing time (excluding paused time)
    let actualPlayTime = 0;
    if (guildQueue.songStartTime) {
        const totalElapsed = Date.now() - guildQueue.songStartTime;
        let currentPauseTime = guildQueue.pausedTime;
        
        // Add current pause duration if currently paused
        if (guildQueue.isPaused && guildQueue.pauseStartTime) {
            currentPauseTime += Date.now() - guildQueue.pauseStartTime;
        }
        
        actualPlayTime = Math.floor((totalElapsed - currentPauseTime) / 1000);
        actualPlayTime = Math.max(0, actualPlayTime); // Ensure non-negative
    }
    
    const duration = currentSong.duration ? parseInt(currentSong.duration) : 0;
    
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const createProgressBar = (current, total) => {
        const percentage = total > 0 ? Math.min(current / total, 1) : 0;
        const progressLength = 15;
        const filledLength = Math.round(progressLength * percentage);
        
        // Use cleaner progress bar characters
        const filled = '━'.repeat(filledLength);
        const empty = '━'.repeat(progressLength - filledLength);
        const slider = '🔘';
        
        if (filledLength === 0) {
            return `🔘${empty}`;
        } else if (filledLength === progressLength) {
            return `${filled}🔘`;
        } else {
            return `${filled}🔘${empty}`;
        }
    };

    // Create a cleaner status indicator
    const statusIcon = guildQueue.isPaused ? '⏸' : '🎵';
    const statusText = guildQueue.isPaused ? 'Paused' : 'Now Playing';

    const embed = new EmbedBuilder()
        .setColor(guildQueue.isPaused ? 0xffa500 : 0x00ff88) // Orange for paused, green for playing
        .setAuthor({ 
            name: statusText, 
            iconURL: 'https://cdn.discordapp.com/emojis/741605543946493028.png' // Music note emoji
        })
        .setDescription(`**${currentSong.title}**`)
        .addFields(
            { 
                name: `${formatTime(actualPlayTime)} / ${duration > 0 ? formatTime(duration) : '--:--'}`, 
                value: createProgressBar(actualPlayTime, duration), 
                inline: false 
            },
            { name: 'Requested by', value: `<@${currentSong.requestedBy.id}>`, inline: true },
            { name: 'Status', value: statusIcon + ' ' + statusText, inline: true },
            { name: '\u200b', value: '\u200b', inline: true } // Invisible third field for alignment
        )
        .setThumbnail(currentSong.thumbnail || null)
        .setFooter({ text: 'Noibat Music Player' })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('rewind_btn')
                .setEmoji('⏮️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('playpause_btn')
                .setEmoji(guildQueue.isPaused ? '▶️' : '⏸️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('skip_btn')
                .setEmoji('⏭️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('view_toggle_btn')
                .setLabel('📋 Queue')
                .setStyle(ButtonStyle.Secondary)
        );

    return { embed, row };
}

function createQueueEmbed(guildQueue) {
    const currentSong = guildQueue.songs[0];
    const upcomingSongs = guildQueue.songs.slice(1, 11); // Show up to 10 upcoming songs
    
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    let queueText = '';
    
    // Current song
    queueText += `**🎵 Now Playing:**\n`;
    queueText += `**${currentSong.title}**\n`;
    queueText += `Requested by <@${currentSong.requestedBy.id}>\n\n`;
    
    // Upcoming songs
    if (upcomingSongs.length > 0) {
        queueText += `**📋 Up Next:**\n`;
        upcomingSongs.forEach((song, index) => {
            const duration = song.duration ? formatTime(parseInt(song.duration)) : '--:--';
            queueText += `\`${index + 1}.\` **${song.title}** \`[${duration}]\`\n`;
            queueText += `    Requested by <@${song.requestedBy.id}>\n`;
        });
        
        if (guildQueue.songs.length > 11) {
            queueText += `\n*...and ${guildQueue.songs.length - 11} more songs*`;
        }
    } else {
        queueText += `**📋 Up Next:**\n*Queue is empty*`;
    }
    
    // Previous songs
    if (guildQueue.previousSongs.length > 0) {
        queueText += `\n\n**⏮️ Previous:**\n`;
        const recentPrevious = guildQueue.previousSongs.slice(-3).reverse(); // Last 3 previous songs
        recentPrevious.forEach((song, index) => {
            queueText += `**${song.title}**\n`;
        });
    }

    const embed = new EmbedBuilder()
        .setColor(guildQueue.isPaused ? 0xffa500 : 0x00ff88)
        .setAuthor({ 
            name: 'Music Queue', 
            iconURL: 'https://cdn.discordapp.com/emojis/741605543946493028.png'
        })
        .setDescription(queueText)
        .setThumbnail(currentSong.thumbnail || null)
        .setFooter({ text: `Total: ${guildQueue.songs.length} song${guildQueue.songs.length !== 1 ? 's' : ''} | Noibat Music Player` })
        .setTimestamp();

    // Create buttons with view toggle
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('rewind_btn')
                .setEmoji('⏮️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('playpause_btn')
                .setEmoji(guildQueue.isPaused ? '▶️' : '⏸️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('skip_btn')
                .setEmoji('⏭️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('view_toggle_btn')
                .setLabel('📊 Now Playing')
                .setStyle(ButtonStyle.Secondary)
        );

    return { embed, row };
}

function createEmbed(guildQueue) {
    if (guildQueue.currentView === 'queue') {
        return createQueueEmbed(guildQueue);
    } else {
        return createNowPlayingEmbed(guildQueue);
    }
}

async function cleanupNowPlayingMessages(guildQueue) {
    if (!guildQueue || guildQueue.nowPlayingMessages.size === 0) return;
    
    // Delete all tracked nowplaying messages
    for (const [messageId, messageData] of guildQueue.nowPlayingMessages) {
        try {
            const channel = client.channels.cache.get(messageData.channelId);
            if (channel) {
                const message = await channel.messages.fetch(messageData.messageId);
                if (message) {
                    // Delete the message after a short delay
                    setTimeout(async () => {
                        try {
                            await message.delete();
                        } catch (error) {
                            // Message might already be deleted, ignore error
                        }
                    }, 5000); // 5 second delay
                }
            }
        } catch (error) {
            // Message probably already deleted, ignore
        }
    }
    
    // Clear the tracking map
    guildQueue.nowPlayingMessages.clear();
    
    // Stop update interval
    if (guildQueue.updateInterval) {
        clearInterval(guildQueue.updateInterval);
        guildQueue.updateInterval = null;
    }
}

async function playSong(guild, song, sendEmbed = true) {
    const guildQueue = queue.get(guild.id);
    if (!song) {
        await cleanupNowPlayingMessages(guildQueue);
        guildQueue.connection.destroy();
        queue.delete(guild.id);
        return;
    }

    try {
        const stream = ytdl(song.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25
        });

        const resource = createAudioResource(stream);
        guildQueue.player.play(resource);
        guildQueue.isPlaying = true;
        guildQueue.isPaused = false;
        guildQueue.songStartTime = Date.now();
        guildQueue.pausedTime = 0; // Reset pause tracking for new song
        guildQueue.pauseStartTime = null;

        // Send automatic nowplaying embed only if requested
        if (sendEmbed) {
            const { embed, row } = createEmbed(guildQueue);
            const message = await guildQueue.textChannel.send({ embeds: [embed], components: [row] });
            
            // Track this message for auto-updates
            guildQueue.nowPlayingMessages.set(message.id, {
                channelId: guildQueue.textChannel.id,
                messageId: message.id,
                userId: 'auto'
            });
            
            // Start auto-update interval if not already running
            if (!guildQueue.updateInterval) {
                startNowPlayingUpdates(guild.id);
            }
        }
    } catch (error) {
        console.error('Error creating audio resource:', error);
        guildQueue.textChannel.send('❌ Error playing the song. Skipping...');
        guildQueue.songs.shift();
        if (guildQueue.songs.length > 0) {
            playSong(guild, guildQueue.songs[0], false);
        }
    }
}

client.on('error', console.error);
client.on('warn', console.warn);

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

client.login(process.env.DISCORD_TOKEN);