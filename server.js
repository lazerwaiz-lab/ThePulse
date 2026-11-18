require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer'); // <--- Indispensable pour l'upload
const { createClient } = require('@supabase/supabase-js'); // <--- Indispensable pour Supabase
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Chargement sécurisé de Firebase (Compatible Local et Render)
let serviceAccount;
if (process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID || "sap-sofitel",
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
        universe_domain: "googleapis.com"
    };
} else {
    serviceAccount = require('./serviceAccountKey.json');
}

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname)));

// Configuration de Multer (mémoire tampon)
const upload = multer({ storage: multer.memoryStorage() });

// Initialisation de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Middleware de vérification d'authentification pour bloquer les écritures non autorisées
const verifyAuthToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Accès refusé. Token manquant." });
    }
    const token = authHeader.split('Bearer ')[1];
    
    if (token === "SAP_SECRET_TOKEN_2026") {
        next();
    } else {
        res.status(403).json({ error: "Token invalide." });
    }
};

// ==========================================
// ROUTE DE VÉRIFICATION DU MOT DE PASSE ADMIN
// ==========================================
app.post('/api/verify-admin', async (req, res) => {
    try {
        const { password } = req.body;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPassword) {
            return res.status(500).json({ success: false, message: "Configuration serveur incomplète (mot de passe admin manquant)." });
        }

        if (password !== adminPassword) {
            return res.status(401).json({ success: false, message: "Mot de passe administrateur incorrect !" });
        }

        res.json({ success: true, message: "Mot de passe correct." });
    } catch (error) {
        console.error("Erreur vérification admin :", error);
        res.status(500).json({ success: false, message: "Erreur serveur." });
    }
});

// ==========================================
// ROUTE D'ÉCRITURE / MODIFICATION SÉCURISÉE (Staff)
// Avec anti-doublons stricts et gestion propre du changement de matricule
// ==========================================
app.post('/api/staff', verifyAuthToken, async (req, res) => {
    try {
        const { id, force, ...data } = req.body;
        
        if (!id) {
            return res.status(400).json({ success: false, error: "ID de l'employé manquant." });
        }

        const sftIdToCheck = (id || '').trim();
        const nomToCheck = (data.nom || '').trim().toLowerCase();
        const prenomToCheck = (data.prenom || '').trim().toLowerCase();

        // 1. Vérification si le matricule exact existe déjà
        const docRef = db.collection('sofitel_cotonou_staff').doc(id);
        const docSnap = await docRef.get();

        if (docSnap.exists && !force) {
            const existingData = docSnap.data();
            // On renvoie un 200 avec conflict: true pour garder la console propre
            return res.status(200).json({ 
                success: false, 
                conflict: true,
                existingMatricule: id,
                existingName: `${existingData.nom || ''} ${existingData.prenom || ''}`.trim(),
                error: `Le matricule "${id}" existe déjà pour ${existingData.nom} ${existingData.prenom}.` 
            });
        }

        // 2. Vérification des doublons de Nom & Prénom sur les autres documents
        const snapshot = await db.collection('sofitel_cotonou_staff').get();
        let oldDocRefToClean = null;
        let creationDate = new Date().toISOString();

        for (const doc of snapshot.docs) {
            const existingData = doc.data();
            const existingNom = (existingData.nom || '').trim().toLowerCase();
            const existingPrenom = (existingData.prenom || '').trim().toLowerCase();

            if (nomToCheck && prenomToCheck && existingNom === nomToCheck && existingPrenom === prenomToCheck) {
                if (doc.id !== id) {
                    oldDocRefToClean = doc.ref; 
                    if (existingData.createdAt) {
                        creationDate = existingData.createdAt; 
                    }
                } else if (docSnap.exists && docSnap.data().createdAt) {
                    creationDate = docSnap.data().createdAt;
                }

                if (!force && doc.id !== id) {
                    return res.status(200).json({ 
                        success: false, 
                        conflict: true,
                        existingMatricule: doc.id,
                        existingName: `${existingData.nom || ''} ${existingData.prenom || ''}`.trim(),
                        error: `L'employé existe déjà sous un autre matricule.` 
                    });
                }
            }
        }

        // 3. Construction des données de l'employé
        const staffPayload = {
            sftId: id,
            nom: data.nom || '',
            prenom: data.prenom || '',
            genre: data.genre || 'M',
            email: data.email || '',
            phone: data.phone || '',
            phoneCode: data.phoneCode || '',
            departement: data.departement || '',
            Conduite: data.Conduite || 'Non',
            hotel: data.hotel || 'Sofitel Cotonou Marina',
            statut: data.statut || 'active',
            photo: data.photo || '',
            qrCode: data.qrCode || '',
            createdAt: creationDate,
            updatedAt: new Date().toISOString()
        };

        await docRef.set(staffPayload);

        if (oldDocRefToClean && oldDocRefToClean.id !== id) {
            await oldDocRefToClean.delete();
        }

        res.status(200).json({ success: true, message: "Employé enregistré et mis à jour avec succès." });
        
    } catch (error) {
        // Les vraies erreurs techniques (crash serveur, pblm Firestore) écriront dans les logs serveur, masquées pour le client
        res.status(500).json({ success: false, error: "Erreur interne du serveur." });
    }
});

// Route pour supprimer un employé et l'archiver dans 'sofitel_cotonou_staff_gone'
app.delete('/api/staff/:id', async (req, res) => {
    try {
        const { password } = req.body;
        const adminPassword = process.env.ADMIN_PASSWORD;
        
        if (!adminPassword || password !== adminPassword) {
            return res.status(403).json({ 
                success: false, 
                message: "Accès refusé : mot de passe administrateur incorrect ou non configuré." 
            });
        }

        const staffId = req.params.id;
        const activeDocRef = db.collection('sofitel_cotonou_staff').doc(staffId);
        const docSnap = await activeDocRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({
                success: false,
                message: "Employé introuvable dans la base de données."
            });
        }

        const staffData = docSnap.data();
        const archiveData = {
            ...staffData,
            deletedAt: new Date().toISOString()
        };

        const archiveDocRef = db.collection('sofitel_cotonou_staff_gone').doc(staffId);
        const batch = db.batch();
        batch.set(archiveDocRef, archiveData); 
        batch.delete(activeDocRef);            

        await batch.commit();

        res.json({ 
            success: true, 
            message: "Employé supprimé et archivé avec succès." 
        });

    } catch (error) {
        console.error("Erreur lors de la suppression/archivage :", error);
        res.status(500).json({ 
            success: false, 
            message: "Erreur interne du serveur : " + error.message
        });
    }
});

// Route pour récupérer tous les employés
app.get('/api/staff', async (req, res) => {
    try {
        const snapshot = await db.collection('sofitel_cotonou_staff').get();
        const staffList = [];
        snapshot.forEach(doc => {
            staffList.push({ id: doc.id, ...doc.data() });
        });
        res.status(200).json(staffList);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Route pour récupérer un employé spécifique par son ID ou sftId
app.get('/api/staff/:id', async (req, res) => {
    try {
        const searchId = decodeURIComponent(req.params.id).trim();
        let docRef = db.collection('sofitel_cotonou_staff').doc(searchId);
        let docSnap = await docRef.get();

        if (docSnap.exists) {
            return res.status(200).json(docSnap.data());
        }

        const snapshot = await db.collection('sofitel_cotonou_staff')
            .where('sftId', '==', searchId)
            .get();

        if (!snapshot.empty) {
            return res.status(200).json(snapshot.docs[0].data());
        }

        res.status(404).json({ error: "Employé non trouvé" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Route d'upload vers Supabase Storage (format prenom_nom_matricule.ext)
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "Aucun fichier fourni." });
        }

        // Récupération des champs envoyés par le frontend
        const rawPrenom = req.body.prenom || 'employe';
        const rawNom = req.body.nom || '';
        const rawMatricule = req.body.matricule || 'SFT-0000';

        // Fonction de nettoyage des caractères spéciaux et des accents
        const sanitize = (str) => {
            return str
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_')
                .replace(/_+/g, '_') // Évite les doubles underscores
                .replace(/^_|_$/g, ''); // Supprime les underscores au début/fin
        };

        const cleanPrenom = sanitize(rawPrenom);
        const cleanNom = sanitize(rawNom);
        const cleanMatricule = sanitize(rawMatricule);

        const fileExt = req.file.originalname.split('.').pop();
        
        // Format final : prenom_nom_matricule.ext (ex: severin_bosse_sft_a599400q699z.jpg)
        const fileName = `${cleanPrenom}_${cleanNom}_${cleanMatricule}.${fileExt}`;
        const filePath = `staff-photos/${fileName}`;

        console.log(`📤 Upload vers Supabase du fichier : ${filePath}`);

        const { data, error } = await supabase.storage
            .from('staff-photos') 
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true // Écrase l'ancienne photo si elle existe déjà pour cet employé
            });

        if (error) throw error;

        const { data: publicUrlData } = supabase.storage
            .from('staff-photos')
            .getPublicUrl(filePath);

        res.json({ url: publicUrlData.publicUrl });
    } catch (err) {
        console.error("❌ Erreur Supabase Storage:", err);
        res.status(500).json({ error: err.message });
    }
});

// Route centralisée pour exécuter les actions sécurisées sur la base de données
app.post('/api/executeDbAction', async (req, res) => {
    try {
        const { password, action, collection, id } = req.body;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPassword || password !== adminPassword) {
            return res.status(403).json({ 
                success: false, 
                message: "Accès refusé : mot de passe administrateur incorrect ou non configuré." 
            });
        }

        if (action === 'delete') {
            if (!collection || !id) {
                return res.status(400).json({ success: false, message: "Paramètres manquants." });
            }

            await db.collection(collection).doc(id).delete();

            return res.json({ 
                success: true, 
                message: "Suppression effectuée avec succès." 
            });
        }

        res.status(400).json({ success: false, message: "Action inconnue." });

    } catch (error) {
        console.error("Erreur serveur executeDbAction :", error);
        res.status(500).json({ 
            success: false, 
            message: "Erreur interne du serveur : " + error.message 
        });
    }
});

// 1. Récupérer la liste des utilisateurs supprimés (staff_gone)
app.get('/api/staff-gone', async (req, res) => {
    try {
        const snapshot = await db.collection('sofitel_cotonou_staff_gone').get();
        const staffList = [];
        snapshot.forEach(doc => {
            staffList.push({ id: doc.id, ...doc.data() });
        });
        res.json(staffList);
    } catch (error) {
        console.error("Erreur fetch staff-gone:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Restaurer un utilisateur
app.post('/api/staff/restore/:id', async (req, res) => {
    try {
        const { password } = req.body;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPassword || password !== adminPassword) {
            return res.status(401).json({ success: false, message: "Mot de passe administrateur incorrect." });
        }

        const staffId = req.params.id;
        const goneDocRef = db.collection('sofitel_cotonou_staff_gone').doc(staffId);
        const goneDoc = await goneDocRef.get();

        if (!goneDoc.exists) {
            return res.status(404).json({ success: false, message: "Utilisateur introuvable dans les archives." });
        }

        const staffData = goneDoc.data();
        staffData.statut = 'active';
        delete staffData.deletedAt;

        await db.collection('sofitel_cotonou_staff').doc(staffId).set(staffData);
        await goneDocRef.delete();

        res.json({ success: true, message: "Utilisateur restauré avec succès." });
    } catch (error) {
        console.error("Erreur restore:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Supprimer définitivement un utilisateur de staff_gone (Supabase & Firestore)
app.delete('/api/staff-gone/:id', async (req, res) => {
    try {
        const { password } = req.body;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPassword || password !== adminPassword) {
            return res.status(401).json({ success: false, message: "Mot de passe administrateur incorrect." });
        }

        const staffId = req.params.id;
        const docRef = db.collection('sofitel_cotonou_staff_gone').doc(staffId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: "Utilisateur introuvable dans les archives." });
        }

        const staffData = docSnap.data();

        // 🗑️ ÉTAPE 1 : SUPPRESSION SUR SUPABASE STORAGE
        if (staffData.photo && staffData.photo.includes('supabase.co')) {
            try {
                // Extraction du chemin relatif depuis l'URL publique
                const urlObj = new URL(staffData.photo);
                const pathSegments = urlObj.pathname.split('/public/staff-photos/');
                
                if (pathSegments.length > 1) {
                    let relativePath = decodeURIComponent(pathSegments[1].split('?')[0]);
                    
                    // Si le fichier est dans le sous-dossier staff-photos du bucket
                    if (!relativePath.startsWith('staff-photos/')) {
                        relativePath = `staff-photos/${relativePath}`;
                    }

                    console.log(`🗑️ Suppression dans Supabase du chemin : ${relativePath}`);
                    
                    const { data, error: supabaseError } = await supabase.storage
                        .from('staff-photos')
                        .remove([relativePath]);

                    if (supabaseError) {
                        console.error("❌ Échec Supabase Storage :", supabaseError);
                        return res.status(500).json({ 
                            success: false, 
                            message: "Échec de la suppression du média sur Supabase : " + supabaseError.message 
                        });
                    }
                    console.log("✅ Fichier supprimé avec succès de Supabase :", data);
                }
            } catch (storageErr) {
                console.error("❌ Erreur technique Supabase :", storageErr);
                return res.status(500).json({ 
                    success: false, 
                    message: "Erreur lors du traitement du fichier distant sur Supabase." 
                });
            }
        }

        // ÉTAPE 2 : SUPPRESSION DANS FIRESTORE
        await docRef.delete();

        res.json({ success: true, message: "Média sur Supabase et utilisateur supprimés définitivement avec succès." });
    } catch (error) {
        console.error("❌ Erreur permanent delete:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
    console.log(`Serveur backend SAP démarré sur le port ${PORT}`);
});