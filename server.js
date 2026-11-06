const express = require('express');
const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createClient } = require('@supabase/supabase-js'); // 🟢 Import de Supabase
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const serviceAccount = require('./serviceAccountKey.json');

// Initialisation modulaire correcte de Firebase
initializeApp({
  credential: cert(serviceAccount)
});

// Initialisation de Firestore et Supabase
const db = getFirestore();

// 🟢 Initialisation du client Supabase (avec tes clés de configuration)
const supabaseUrl = 'https://wogcnzukwoekalnkwied.supabase.co';
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();

// ==========================================
// GESTION DYNAMIQUE DE L'ENVIRONNEMENT (PROD / LOCAL)
// ==========================================
const isProduction = process.env.NODE_ENV === 'production';

// Liste des origines autorisées dynamiquement pour CORS
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://thepulse-9vi1.onrender.com/' // Remplace par ton vrai domaine en prod si nécessaire
];

app.use(cors({
    origin: function (origin, callback) {
        // Autoriser les requêtes sans origine (Postman, scripts serveur à serveur, etc.) en local
        if (!origin && !isProduction) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1 && isProduction) {
            return callback(new Error('Bloqué par la politique CORS (Production)'), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// Middlewares globaux
app.use(express.json());
app.use(express.static(path.join(__dirname)));
// app.use(express.static(path.join(__dirname, '../')));

// ==========================================
// FONCTION UTILITAIRE : Génération du hotelID unique
// ==========================================
function generateHotelID(hotelName) {
    const cleanName = hotelName ? hotelName.replace(/[^a-zA-Z]/g, '').toUpperCase() : 'HOT';
    const prefix = cleanName.substring(0, 3).padEnd(3, 'X');
    const upperChar = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const lowerChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
    const digits = Math.floor(100 + Math.random() * 900);
    const randomLowerString = Array.from({ length: 3 }, () => 
        String.fromCharCode(97 + Math.floor(Math.random() * 26))
    ).join('');

    return `${prefix}-PULSE-${upperChar}${lowerChar}${digits}${randomLowerString}`;
}

// ==========================================
// 1. INSCRIPTION
// ==========================================
app.post('/api/signup', async (req, res) => {
    try {
        const { hotelName, email, password, planId } = req.body;
        
        if (!hotelName || !email || !password) {
            return res.status(400).json({ success: false, message: 'Tous les champs sont obligatoires.' });
        }

        const cleanHotelName = hotelName.trim();

        const hotelRef = db.collection('hotels').doc(cleanHotelName);
        const hotelDoc = await hotelRef.get();
        if (hotelDoc.exists) {
            return res.status(400).json({ success: false, message: 'Cet établissement existe déjà.' });
        }

        const hotelID = generateHotelID(cleanHotelName);
        const now = Date.now();

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await hotelRef.set({
            hotelName: cleanHotelName,
            hotelID: hotelID,
            email: email,
            createdAt: now
        }, { merge: true });

        const userRef = hotelRef.collection('users').doc(email);
        await userRef.set({
            email: email,
            password: hashedPassword,
            createdAt: now
        }, { merge: true });

        const cycleDurationMs = 35 * 24 * 60 * 60 * 1000;
        const subRef = hotelRef.collection('subscription').doc('current');
        await subRef.set({
            type: planId || 'business',
            subscriptionEnd: now + cycleDurationMs,
            createdAt: now
        }, { merge: true });

        res.json({ 
            success: true, 
            message: 'Hôtel, utilisateur et abonnement initialisés avec succès par le serveur.', 
            hotelName: cleanHotelName,
            hotelID: hotelID 
        });
    } catch (error) {
        console.error("Erreur Signup :", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 1.bis. CONNEXION
// ==========================================
app.post('/api/verify-hotel', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });
        }

        const hotelsSnapshot = await db.collection('hotels').get();

        if (hotelsSnapshot.empty) {
            return res.status(404).json({ success: false, message: 'Aucun établissement trouvé dans la base.' });
        }

        let foundHotelId = null;
        let userData = null;

        for (const hotelDoc of hotelsSnapshot.docs) {
            const hotelId = hotelDoc.id;
            const userDocRef = db.collection('hotels').doc(hotelId).collection('users').doc(email);
            const userDocSnap = await userDocRef.get();

            if (userDocSnap.exists) {
                foundHotelId = hotelId;
                userData = userDocSnap.data();
                break;
            }
        }

        if (!foundHotelId || !userData) {
            return res.status(404).json({ success: false, message: 'Établissement ou utilisateur non trouvé.' });
        }

        const isPasswordValid = await bcrypt.compare(password, userData.password);

        if (!isPasswordValid) {
            return res.status(401).json({ success: false, message: 'Mot de passe incorrect.' });
        }

        res.json({ 
            success: true, 
            hotelName: foundHotelId, 
            message: 'Connexion serveur réussie.' 
        });

    } catch (error) {
        console.error("Erreur Login :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 2. ROUTES GESTION DES TOTEMS
// ==========================================
app.get('/api/hotels/:uid/totems', async (req, res) => {
    try {
        const { uid } = req.params;
        const snapshot = await db.collection('hotels').doc(uid).collection('totems').get();
        let totems = {};
        snapshot.forEach(doc => {
            totems[doc.id] = doc.data();
        });
        res.json({ success: true, data: totems });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/hotels/:uid/totems', async (req, res) => {
    try {
        const { uid } = req.params;
        const { name, orientation } = req.body;
        
        if (!name) {
            return res.status(400).json({ success: false, error: "Le nom du totem est requis" });
        }

        const totemsRef = db.collection('hotels').doc(uid).collection('totems');
        const snapshot = await totemsRef.get();

        const cleanOrientation = (orientation || '').trim().toLowerCase();
        const orientationCode = (cleanOrientation === 'paysage' || cleanOrientation.startsWith('l')) ? 'L' : 'P';

        let sameTypeCount = 0;
        snapshot.forEach(doc => {
            if (doc.id.startsWith(`TOT-${orientationCode}-`)) {
                sameTypeCount++;
            }
        });
        
        const nextNumber = sameTypeCount + 1;
        const totemId = `TOT-${orientationCode}-${nextNumber}`;

        const totemRef = totemsRef.doc(totemId);
        const totemData = { 
            name: name.trim(), 
            orientation: orientation || 'Portrait', 
            createdAt: Date.now(),
            totemId: totemId
        };
        
        await totemRef.set(totemData, { merge: true });

        res.json({ success: true, message: 'Totem ajouté avec succès', id: totemId, totem: totemData });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/hotels/:uid/totems/:totemId', async (req, res) => {
    try {
        const { uid, totemId } = req.params;
        
        const totemRef = db.collection('hotels').doc(uid).collection('totems').doc(totemId);
        
        const totemDoc = await totemRef.get();
        if (totemDoc.exists) {
            const totemData = totemDoc.data();
            const totemName = totemData.name;

            if (totemName) {
                const mediaDocRef = db.collection('hotels').doc(uid).collection('media').doc(totemName);
                const mediaDoc = await mediaDocRef.get();

                if (mediaDoc.exists) {
                    const mediaData = mediaDoc.data();

                    for (const mediaId of Object.keys(mediaData)) {
                        const mediaItem = mediaData[mediaId];
                        if (mediaItem && mediaItem.url && mediaItem.url.includes('supabase.co')) {
                            try {
                                const urlParts = mediaItem.url.split('/');
                                const fileName = urlParts[urlParts.length - 1];
                                if (fileName) {
                                    await supabase.storage
                                        .from('media')
                                        .remove([decodeURIComponent(fileName)]);
                                }
                            } catch (storageErr) {
                                console.error("Erreur suppression Supabase pour le média", mediaId, storageErr);
                            }
                        }
                    }

                    await mediaDocRef.delete();
                }
            }
        }

        await totemRef.delete();

        res.json({ success: true, message: 'Totem et médias associés supprimés avec succès.' });
    } catch (error) {
        console.error("Erreur lors de la suppression du totem :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const { FieldValue } = require('firebase-admin').firestore;

// ==========================================
// ROUTE GET : Récupérer tous les médias
// ==========================================
app.get('/api/hotels/:uid/media', async (req, res) => {
    try {
        const { uid } = req.params;
        const mediaRef = db.collection('hotels').doc(uid).collection('media');
        const totemsSnapshot = await mediaRef.get();
        
        let allMediaData = {};

        totemsSnapshot.forEach(totemDoc => {
            const totemName = totemDoc.id;
            allMediaData[totemName] = totemDoc.data() || {};
        });

        res.json({ success: true, data: allMediaData });
    } catch (error) {
        console.error("Erreur API media:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// ROUTE POST : Ajouter/Mettre à jour un média
// ==========================================
app.post('/api/hotels/:uid/media/:totemName', async (req, res) => {
    try {
        const { uid, totemName } = req.params;
        const mediaData = req.body;
        const mediaId = mediaData.id || `media_${Date.now()}`;
        
        const totemDocRef = db.collection('hotels')
                                   .doc(uid)
                                   .collection('media')
                                   .doc(totemName);
        
        await totemDocRef.set({
            [mediaId]: {
                ...mediaData,
                createdAt: Date.now()
            }
        }, { merge: true });

        res.json({ success: true, message: 'Média enregistré avec succès.', mediaId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/hotels/:uid/media/:totemName/:mediaId', async (req, res) => {
    try {
        const { uid, totemName, mediaId } = req.params;
        
        const totemDocRef = db.collection('hotels')
                                .doc(uid)
                                .collection('media')
                                .doc(totemName);
                                
        const docSnap = await totemDocRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({ success: false, error: "Totem introuvable." });
        }

        const totemData = docSnap.data();
        const mediaData = totemData[mediaId];

        if (!mediaData || !mediaData.url) {
            console.error(`❌ [DELETE] Aucune URL trouvée pour le média ${mediaId} dans Firestore !`);
            return res.status(400).json({ success: false, error: "URL du média introuvable dans Firestore." });
        }

        // Extraction rigoureuse du nom du fichier
        const cleanUrl = mediaData.url.split('?')[0];
        const urlParts = cleanUrl.split('/');
        const fileName = urlParts[urlParts.length - 1];

        if (!fileName) {
            return res.status(400).json({ success: false, error: "Nom de fichier invalide extrait de l'URL." });
        }

        const decodedFileName = decodeURIComponent(fileName);
        console.log(`🚀 [SUPABASE] Suppression physique demandée pour : "${decodedFileName}"`);

        // Appel direct et synchrone à Supabase
        const { data, error: supabaseError } = await supabase.storage
            .from('media')
            .remove([decodedFileName]);

        if (supabaseError) {
            console.error("❌ [SUPABASE ERROR] :", supabaseError);
            return res.status(500).json({ success: false, error: "Erreur Supabase: " + supabaseError.message });
        }

        console.log("✅ [SUPABASE SUCCESS] Fichier effacé du bucket :", data);

        // 4. Suppression du champ spécifique du média dans Firestore uniquement si Supabase a réussi
        await totemDocRef.update({
            [mediaId]: FieldValue.delete()
        });
        
        res.json({ success: true, message: 'Média supprimé avec succès de Supabase et Firestore.' });
    } catch (error) {
        console.error("❌ Erreur API delete media:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// ROUTE PUT : Mettre à jour l'ordre des médias par lot
// ==========================================
app.put('/api/hotels/:uid/media/order', async (req, res) => {
    try {
        const { uid } = req.params;
        const { items } = req.body;

        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ success: false, error: "Format de données invalide." });
        }

        const batch = db.batch();

        items.forEach(item => {
            const totemDocRef = db.collection('hotels')
                                    .doc(uid)
                                    .collection('media')
                                    .doc(item.totemName);
            
            batch.update(totemDocRef, {
                [`${item.mediaId}.order`]: item.order
            });
        });

        await batch.commit();

        res.json({ success: true, message: "Ordre mis à jour avec succès." });
    } catch (error) {
        console.error("Erreur API update order:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 4. ROUTES CATALOGUE WORLDWIDE & CONFIG
// ==========================================
app.get('/api/hotels/:uid/worldwide', async (req, res) => {
    try {
        const { uid } = req.params;
        const doc = await db.collection('hotels').doc(uid).collection('worldwide').doc('config').get();
        res.json({ success: true, data: doc.exists ? doc.data() : {} });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/hotels/:uid/worldwide/config', async (req, res) => {
    try {
        const { uid } = req.params;
        const { kkiaPayKey, alertEmail } = req.body;
        await db.collection('hotels').doc(uid).collection('worldwide').doc('config').set({ kkiaPayKey, alertEmail }, { merge: true });
        res.json({ success: true, message: 'Configuration Worldwide enregistrée.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 5. ROUTES ABONNEMENT
// ==========================================
async function updateSubscriptionHandler(req, res) {
    try {
        const { uid } = req.params;
        const { type, subscriptionEnd } = req.body;
        await db.collection('hotels').doc(uid).collection('subscription').doc('current').set({ type, subscriptionEnd }, { merge: true });
        res.json({ success: true, message: 'Abonnement mis à jour avec succès.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

app.route('/api/hotels/:uid/subscription')
    .get(async (req, res) => {
        try {
            const { uid } = req.params;
            const doc = await db.collection('hotels').doc(uid).collection('subscription').doc('current').get();
            res.json({ success: true, data: doc.exists ? doc.data() : {} });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    .post(updateSubscriptionHandler)
    .put(updateSubscriptionHandler);

// ==========================================
// 7. ROUTE INFOS HOTEL
// ==========================================
app.get('/api/hotels/:hotelName/info', async (req, res) => {
    try {
        const { hotelName } = req.params;
        const hotelRef = db.collection('hotels').doc(hotelName);
        const hotelDoc = await hotelRef.get();

        if (!hotelDoc.exists) {
            return res.status(404).json({ success: false, message: 'Établissement non trouvé.' });
        }

        const hotelData = hotelDoc.data();

        const subDoc = await hotelRef.collection('subscription').doc('current').get();
        const subscriptionData = subDoc.exists ? subDoc.data() : {};

        res.json({
            success: true,
            hotelName: hotelData.hotelName,
            hotelID: hotelData.hotelID || hotelName,
            subscription: subscriptionData
        });
    } catch (error) {
        console.error("Erreur Hotel Info :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 8. Lancement dynamique du serveur selon l'environnement
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne [Mode: ${isProduction ? 'PRODUCTION' : 'LOCAL'}] sur le port ${PORT}`);
});